import _ from 'lodash';
import buildUrl from 'build-url';
import moment from 'moment';

import { BaseScraper, LOGIN_RESULT } from './base-scraper';
import {
  SCRAPE_PROGRESS_TYPES,
  NORMAL_TXN_TYPE,
  INSTALLMENTS_TXN_TYPE,
  SHEKEL_CURRENCY_SYMBOL,
  SHEKEL_CURRENCY,
  DOLLAR_CURRENCY_SYMBOL,
  DOLLAR_CURRENCY,
  TRANSACTION_STATUS,
} from '../constants';
import { fetchGet, fetchPost } from '../helpers/fetch';
import { fixInstallments, sortTransactionsByDate, filterOldTransactions } from '../helpers/transactions';

const BASE_URL = 'https://restservices.cal-online.co.il/Cal4U';
const DATE_FORMAT = 'DD/MM/YYYY';

const PASSWORD_EXPIRED_MSG = 'תוקף הסיסמא פג';
const INVALID_CREDENTIALS = 'שם משתמש או הסיסמא שהוזנו שגויים';
const NO_DATA_FOUND_MSG = 'לא נמצאו חיובים לטווח תאריכים זה';

const NORMAL_TYPE_CODE = '5';
const REFUND_TYPE_CODE = '6';
const WITHDRAWAL_TYPE_CODE = '7';
const INSTALLMENTS_TYPE_CODE = '8';
const CANCEL_TYPE_CODE = '25';
const WITHDRAWAL_TYPE_CODE_2 = '27';
const CREDIT_PAYMENTS_CODE = '59';
const MEMBERSHIP_FEE_TYPE_CODE = '67';
const SERVICES_REFUND_TYPE_CODE = '71';
const SERVICES_TYPE_CODE = '72';
const REFUND_TYPE_CODE_2 = '76';

function getBankDebitsUrl(accountId) {
  const toDate = moment().add(2, 'months');
  const fromDate = moment().subtract(6, 'months');

  return buildUrl(BASE_URL, {
    path: `CalBankDebits/${accountId}`,
    queryParams: {
      DebitLevel: 'A',
      DebitType: '2',
      FromMonth: (fromDate.month() + 1).toString().padStart(2, '0'),
      FromYear: fromDate.year().toString(),
      ToMonth: (toDate.month() + 1).toString().padStart(2, '0'),
      ToYear: toDate.year().toString(),
    },
  });
}

function getTransactionsUrl(cardId, debitDate) {
  return buildUrl(BASE_URL, {
    path: `CalTransactions/${cardId}`,
    queryParams: {
      ToDate: debitDate,
      FromDate: debitDate,
    },
  });
}

function convertTransactionType(txnType) {
  switch (txnType) {
    case NORMAL_TYPE_CODE:
    case REFUND_TYPE_CODE:
    case CANCEL_TYPE_CODE:
    case WITHDRAWAL_TYPE_CODE:
    case WITHDRAWAL_TYPE_CODE_2:
    case REFUND_TYPE_CODE_2:
    case SERVICES_REFUND_TYPE_CODE:
    case MEMBERSHIP_FEE_TYPE_CODE:
    case SERVICES_TYPE_CODE:
      return NORMAL_TXN_TYPE;
    case INSTALLMENTS_TYPE_CODE:
    case CREDIT_PAYMENTS_CODE:
      return INSTALLMENTS_TXN_TYPE;
    default:
      throw new Error(`unknown transaction type ${txnType}`);
  }
}

function convertCurrency(currency) {
  switch (currency) {
    case SHEKEL_CURRENCY_SYMBOL:
      return SHEKEL_CURRENCY;
    case DOLLAR_CURRENCY_SYMBOL:
      return DOLLAR_CURRENCY;
    default:
      return currency;
  }
}

function getInstallmentsInfo(txn) {
  if (!txn.CurrentPayment || txn.CurrentPayment === '0') {
    return null;
  }

  return {
    number: parseInt(txn.CurrentPayment, 10),
    total: parseInt(txn.TotalPayments, 10),
  };
}

function getTransactionMemo(txn) {
  const { TransType: txnType, TransTypeDesc: txnTypeDescription } = txn;
  switch (txnType) {
    case NORMAL_TYPE_CODE:
      return txnTypeDescription === 'רכישה רגילה' ? '' : txnTypeDescription;
    case INSTALLMENTS_TYPE_CODE:
      return `תשלום ${txn.CurrentPayment} מתוך ${txn.TotalPayments}`;
    default:
      return txn.TransTypeDesc;
  }
}

function convertTransactions(txns) {
  return txns.map((txn) => {
    return {
      type: convertTransactionType(txn.TransType),
      date: moment(txn.Date, DATE_FORMAT).toISOString(),
      processedDate: moment(txn.DebitDate, DATE_FORMAT).toISOString(),
      originalAmount: -txn.Amount.Value,
      originalCurrency: convertCurrency(txn.Amount.Symbol),
      chargedAmount: -txn.DebitAmount.Value,
      description: txn.MerchantDetails.Name,
      memo: getTransactionMemo(txn),
      installments: getInstallmentsInfo(txn),
      status: TRANSACTION_STATUS.COMPLETED,
    };
  });
}

function prepareTransactions(txns, startMoment, combineInstallments) {
  let clonedTxns = Array.from(txns);
  if (!combineInstallments) {
    clonedTxns = fixInstallments(clonedTxns);
  }
  clonedTxns = sortTransactionsByDate(clonedTxns);
  clonedTxns = filterOldTransactions(clonedTxns, startMoment, combineInstallments);
  return clonedTxns;
}

async function getBankDebits(authHeader, accountId) {
  const bankDebitsUrl = getBankDebitsUrl(accountId);
  return fetchGet(bankDebitsUrl, authHeader);
}

async function getTransactionsNextPage(authHeader) {
  const hasNextPageUrl = `${BASE_URL}/CalTransNextPage`;
  return fetchGet(hasNextPageUrl, authHeader);
}

async function fetchTxns(authHeader, cardId, debitDates) {
  const txns = [];
  for (const date of debitDates) {
    const fetchTxnUrl = getTransactionsUrl(cardId, date);
    let txnResponse = await fetchGet(fetchTxnUrl, authHeader);
    if (txnResponse.Transactions) {
      txns.push(...txnResponse.Transactions);
    }
    while (txnResponse.HasNextPage) {
      txnResponse = await getTransactionsNextPage(authHeader);
      if (txnResponse.Transactions != null) {
        txns.push(...txnResponse.Transactions);
      }
    }
  }
  return txns;
}

async function getTxnsOfCard(authHeader, card, bankDebits) {
  const cardId = card.Id;
  const cardDebitDates = bankDebits.filter((bankDebit) => {
    return bankDebit.CardId === cardId;
  }).map((cardDebit) => {
    return cardDebit.Date;
  });
  return fetchTxns(authHeader, cardId, cardDebitDates);
}

async function getTransactionsForAllAccounts(authHeader, startMoment, options) {
  const cardsByAccountUrl = `${BASE_URL}/CardsByAccounts`;
  const banksResponse = await fetchGet(cardsByAccountUrl, authHeader);

  if (_.get(banksResponse, 'Response.Status.Succeeded')) {
    const accounts = [];
    for (let i = 0; i < banksResponse.BankAccounts.length; i += 1) {
      const bank = banksResponse.BankAccounts[i];
      const bankDebits = await getBankDebits(authHeader, bank.AccountID);
      //Check that the bank has an active card to scrape
      if (bank.Cards.some(card => card.IsEffectiveInd)) {
        if (_.get(bankDebits, 'Response.Status.Succeeded')) {
          for (let j = 0; j < bank.Cards.length; j += 1) {
            const rawTxns = await getTxnsOfCard(authHeader, bank.Cards[j], bankDebits.Debits);
            if (rawTxns) {
              let txns = convertTransactions(rawTxns);
              txns = prepareTransactions(txns, startMoment, options.combineInstallments);
              const result = {
                accountNumber: bank.Cards[j].LastFourDigits,
                txns,
              };
              accounts.push(result);
            }
          }
        } else {
          const { Description, Message } = bankDebits.Response.Status;

          if (Message !== NO_DATA_FOUND_MSG) {
            const message = `${Description}. ${Message}`;
            throw new Error(message);
          }
        }
      }
    }
    return {
      success: true,
      accounts,
    };
  }

  return { success: false };
}

class VisaCalScraper extends BaseScraper {
  async login(credentials) {
    const authUrl = `${BASE_URL}/CalAuthenticator`;
    const authRequest = {
      username: credentials.username,
      password: credentials.password,
    };

    this.emitProgress(SCRAPE_PROGRESS_TYPES.LOGGING_IN);

    const authResponse = await fetchPost(authUrl, authRequest);
    if (!authResponse || !authResponse.AuthenticationToken) {
      if (_.get(authResponse, 'Response.Status.Message') === PASSWORD_EXPIRED_MSG) {
        return {
          success: false,
          errorType: LOGIN_RESULT.CHANGE_PASSWORD,
        };
      }

      if (_.get(authResponse, 'Response.Status.Message') === INVALID_CREDENTIALS) {
        return {
          success: false,
          errorType: LOGIN_RESULT.INVALID_PASSWORD,
        };
      }
    }

    if (_.get(authResponse, 'Response.Status.Succeeded')) {
      this.authHeader = `CalAuthScheme ${authResponse.AuthenticationToken}`;
      this.emitProgress(SCRAPE_PROGRESS_TYPES.LOGIN_SUCCESS);
      return { success: true };
    }

    throw new Error('unknown error during login');
  }

  async fetchData() {
    const defaultStartMoment = moment().subtract(1, 'years');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(defaultStartMoment, moment(startDate));

    const authHeader = { Authorization: this.authHeader };
    return getTransactionsForAllAccounts(authHeader, startMoment, this.options);
  }

  createAuthHeader() {
    return {
      Authorization: this.authHeader,
    };
  }
}

export default VisaCalScraper;
