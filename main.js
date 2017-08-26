/*jshint esversion: 6 */
/*jslint node: true */
"use strict";

const async = require('async');
const config = require('config');
const dateFormat = require('dateformat');
const extend = require('util')._extend;
const findRoot = require('newton-raphson');
const lc = require('node-lending-club-api');
const os = require('os');
const Promise = require("bluebird");
const Table = require('cli-table');

function getMaxExpirationDate(days) {
  var now = new Date();
  now.setDate(now.getDate() + days);
  return dateFormat(now, "mm/dd/yyyy");
}

function addMonthsUTC (date, count) {
  if (date && count) {
    var date = new Date(+date);
    var m, d = date.getUTCDate();

    date.setUTCMonth(date.getUTCMonth() + count, 1);
    m = date.getUTCMonth();
    date.setUTCDate(d);
    if (date.getUTCMonth() !== m) date.setUTCDate(0);
  }
  return date;
}

function dateClearClock(d) {
    d.setHours(0,0,0,0);
    return new Date(
        d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate());
}

function dateCompare(d1, d2) {
  d1 = dateClearClock(d1);
  d2 = dateClearClock(d2);
  if (d1.getTime() === d2.getTime()) {
    return 0;
  } else if (d1.getTime() < d2.getTime()) {
    return -1;
  }
  return 1;
}

// https://stackoverflow.com/questions/2536379/difference-in-months-between-two-dates-in-javascript
function monthDiff(d1, d2) {
  let months;
  months = (d2.getFullYear() - d1.getFullYear()) * 12;
  months -= d1.getMonth() + 1;
  months += d2.getMonth();
  return months <= 0 ? 0 : months;
}

function calcRemainingPayments(loanLength, dateIssued) {
  const now = new Date();
  const expiration = addMonthsUTC(dateIssued, loanLength);
  const monthsLeft = monthDiff(now, expiration);
  if (monthsLeft === 0) {
    throw Error(
        'Date ' + dateIssued + ' already expired after ' + loanLength +
        ' payments. Today is after such expiration');
  }
  return monthsLeft;
}

function Seconds(n) {
  return n * 1000;
}

function Minutes(n) {
  return n * Seconds(60);
}

function Hours(n) {
  return n * Minutes(60);
}

function Days(n) {
  return n * Hours(24);
}

// https://stackoverflow.com/questions/11832914/round-to-at-most-2-decimal-places-only-if-necessary
function roundNumber(num, scale) {
  if (!("" + num).includes("e")) {
    return +(Math.round(num + "e+" + scale) + "e-" + scale);
  } else {
    var arr = ("" + num).split("e");
    var sig = "";
    if (+arr[1] + scale > 0) {
      sig = "+";
    }
    return +(Math.round(+arr[0] + "e" + sig + (+arr[1] + scale)) + "e-" +
      scale);
  }
}

// interest rate per payment is interest rate / yearly payments
// ie: APR 15% and 12 Payments (monthly payments) -> 15% / 12 => 0.15/12
function calcMonthlyPayment(principal, remainingPayments, interestRatePerPayment) {
  // http://forum.lendacademy.com/index.php?topic=4192.0
  const p = principal;
  const n = remainingPayments;
  const r = interestRatePerPayment;
  return p * ((r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
}

// calculates the YIELD TO MATURITY given the ask price
// YTM = r*12*100.0  in the context of converting
//       r, a monthly interest rate to a yearly one
// r = is initialialy a guess. until we converge
// //
function calcYield(params) {
  const m = params.monthlyPayment;
  // in dollars, this is directly calculated from
  // the actual principalPending (not askingPrice)

  const n = params.remainingPayments; // number of remaining payments
  const pr = params.askPrice; // maybe or not the same as principalPending

  const f = function(r) {
    return m - calcMonthlyPayment(pr, n, r);
  };
  const fprime = function(r) {
    const h = 0.0001; // almost forgot the h again..
    return (f(r + h, m, pr, n) - f(r, m, pr, n)) / h;
  };

  const initialRateGuesstimate = 1.0;
  const monthsInYear = 12;
  return findRoot(f, fprime, initialRateGuesstimate) * monthsInYear;
}

function calcAskPrice(theNote, markup) {
  const principalPlusIntrest =
    theNote.principalPending + theNote.accruedInterest;
  return principalPlusIntrest * (markup + 1);
}

// The question being: Given a particular note, what
// is the highest markup we can sell it at and still
// have a valid markup and valid Yield to Maturity
// that would even interest a buyer..
// NOTE: does not consider any other factors of the
//       note other than strictly YTM
// //
function calcOptimalMarkup(theNote, initialMarkup, acceptableYTM) {
  const initialAskPrice = calcAskPrice(theNote, initialMarkup);
  const remainingPayments = calcRemainingPayments(
    theNote.loanLength, new Date(theNote.issueDate));
  const interestRate = theNote.interestRate / 100 / 12;
  let params = {
    monthlyPayment: calcMonthlyPayment(theNote.principalPending, remainingPayments, interestRate),
    remainingPayments: remainingPayments,
    askPrice: initialAskPrice
  };

  const g = function(markup) {
    let paramsCopy = extend({}, params);
    paramsCopy.askPrice = calcAskPrice(theNote, markup);
    const val = acceptableYTM - calcYield(paramsCopy);
    // console.log('g  : ' + val);
    return val;
  };

  const gprime = function(markup) {
    const h = 0.0001; // almost forgot the h again..
    const delta = (g(markup + h) - g(markup)) / h;
    // console.log('g` : ' + delta);
    return delta;
  };

  return findRoot(g, gprime, initialMarkup);
}

class NoteCollection {
  constructor(rawNotes) {
      this.notes = rawNotes;
    }

  // Filter helpers, does not order notes
    // targetId must be an integer
  byId(targetId) {
      return this.notes.find(function(note) {
        return note.noteId === targetId;
      });
    }
    // loanStatus must be a string
  byLoanStatus(loanStatus) {
      return this.notes.filter(function(note) {
        return note.loanStatus === loanStatus;
      });
    }
    // purpose must be a string
  byPurpose(purpose) {
    return this.notes.filter(function(note) {
      return note.purpose === purpose;
    });
  }
    // date must be formatted: <yyyy>-<mm>-<dd>
  byIssuedDate(date) {
    return this.notes.filter(function(note) {
      return (dateCompare(date, new Date(note.issueDate)) === 0);
    });
  }
    // date must be formatted: <yyyy>-<mm>-<dd>
  byIssuedDateBefore(date) {
    return this.notes.filter(function(note) {
      return (dateCompare(date, new Date(note.issueDate)) > 0);
    });
  }
    // date must be formatted: <yyyy>-<mm>-<dd>
  byIssuedDateAfter(date) {
    return this.notes.filter(function(note) {
      return (dateCompare(date, new Date(note.issueDate)) < 0);
    });
  }

  byMonthsIssued(m) {
    return this.notes.filter(function(note) {
      const dateAfterMonthsLater = addMonthsUTC(new Date(note.issueDate), m);
      return (dateCompare(dateAfterMonthsLater, new Date()) <= 0);
    });
  }

  difference(rhs) {
    return this.notes.filter(function(note) {
      const item = rhs.find((el) => { return (note.noteId === el.noteId) });
      return (item === undefined);
    });
  }
}


function filterSellableNotes(theNotes, acceptableYTM, acceptableMarkup) {
  function calcOptimalAskPrice(theNote) {
    const initialMarkup = 0.005; // initial parameter for calculation
    const markup = calcOptimalMarkup(theNote, initialMarkup, acceptableYTM);
    if (markup && markup > acceptableMarkup) {
      return calcAskPrice(theNote, markup);
    }
    throw Error(
        'Invalid markup calculated: \'' + markup +
        '\' for note: ' + JSON.stringify(theNote));
  }

  function isNoteSellable(theNote) {
    try {
      // (1) asking price must exist for note
      // (2) must at least be greater than principle remaining
      const askingPrice = calcOptimalAskPrice(theNote);
      return askingPrice >= theNote.principalPending;
    } catch (err) {
      return false;
    }
  }

  function appendAskPriceProperty(note) {
    note.askPrice = calcOptimalAskPrice(note);
    return note;
  }

  return theNotes.filter(isNoteSellable).map(appendAskPriceProperty);
}

// NOTE: does not do any linting or data-verification.
//       will consume theNotes data as if it were testing
//       pre-verified (bad stuff 'divide by 0' stuff gone!)
function makeTable(theNotes, acceptableYTM) {
  const table = new Table({
    head: [
      'noteId', 'initialMarkup', 'finalMarkup', 'initialAskingPrice',
      'finalAskingPrice', 'initialYTM', 'finalYTM'
    ],
    colWidths: [14, 12, 12, 12, 12, 12, 12]
  });

  theNotes.forEach((note) => {
    const initialMarkup = 0.005;   // initial parameter for calculation
    const remainingPayments = calcRemainingPayments(
        note.loanLength, new Date(note.issueDate));
    const monthlyPayment = calcMonthlyPayment(
        note.principalPending, remainingPayments,
        note.interestRate / 100 / 12);

    const initialYieldParams = {
      monthlyPayment: monthlyPayment,
      remainingPayments: remainingPayments,
      askPrice: calcAskPrice(note, initialMarkup)
    };
    const finalYieldParams_Estimated_seelendingclub_ytm = {
      monthlyPayment: monthlyPayment,
      remainingPayments: remainingPayments,
      askPrice: calcAskPrice(note, calcOptimalMarkup(note, initialMarkup, acceptableYTM))
    };

    const viewObject = [
      note.noteId,
      initialMarkup,
      roundNumber(calcOptimalMarkup(note, initialMarkup, acceptableYTM), 4),
      roundNumber(calcAskPrice(note, initialMarkup), 2),
      roundNumber(calcAskPrice(note, calcOptimalMarkup(note, initialMarkup, acceptableYTM)), 2),
      roundNumber(calcYield(initialYieldParams), 4),
      roundNumber(calcYield(finalYieldParams_Estimated_seelendingclub_ytm), 4),
    ];
    table.push(viewObject);
  });

  return table;
}


// creates an array of objects that follow the foliofn
// 'sell' endpoint request data schema
// requires param 'theSellNotes' to follow schema:
//   [{theNote: lendingClubNote, askPrice: askPrice}]
function convertNotesToFolioSellSchema(theSellNotes) {
  let notesToSell = [];
  theSellNotes.forEach((theNote) => {
    const askPrice = theNote.askPrice;
    // const markupPercent = `${roundNumber(((askPrice / theNote.principalPending) - 1) * 100, 2)}%`;
    // console.log('Selling note: ' + theNote.noteId +
    //             ' at askPrice: $' + roundNumber(askPrice, 2) +
    //             ' markup: ' + markupPercent);
    if (askPrice < theNote.principalPending) {
      throw Error('Sale was attempted on note: ' + theNote.noteId +
        ' at invalid askPrice: ' + askPrice);
    }
    notesToSell.push({
      "loanId"   : theNote.loanId,
      "orderId"  : theNote.orderId,
      "noteId"   : theNote.noteId,
      "askingPrice" : askPrice,
    });
  });
  return notesToSell;
}

////
////
// NOTE: must accept EULA
// https://www.lendingclub.com/foliofn/apiAccessAgreementSubmit.action
// the link on https://www.lendingclub.com/foliofn/folioInvestingAPIDocument.action
// which is to: https://www.lendingclub.com/foliofn/folio-api-agreement.action
// sometimes is flakey, it worked one day..
//
// This is an example:
//

// https://www.lendingclub.com/foliofn/folioInvestingAPIDocument.action
class Client {
  constructor(apiKey, investorId) {
    lc.init({
      apiKey: apiKey
    });
    this.investorId = investorId;
  }

  buyNotes(notesToBuy) {
    lc.folio.buy(this.investorId, notesToBuy,
      function(err, ret) {
        if (err) {
          console.log('Error: ' + err);
          return;
        }
        console.log(ret);
      });
  }

  sellNotes(notesToSell) {
    return new Promise((resolve, reject) => {
      lc.folio.sell(this.investorId, getMaxExpirationDate(7), notesToSell, (err, ret) => {
        if (err) {
          console.log('Error: ' + err);
          reject(err);
          return;
        }
        resolve(ret);
      });
    });
  }

  // Sells one note at a markup on foliofn (lending club)
  // multiple calls within a second will be 500'd
  // Use this sparingly
  sellNoteAtMarkup(theNote, markup) {
    // console.log('Selling note: ' + theNote.noteId + ' at markup: ' + markup);
    if (markup < 0.0001 || markup >= 0.70) {
      throw Error('Sale was attempted on note: ' + theNote.noteId +
        ' at invalid markup: ' + markup);
    }
    const notesToSell = [{
      "loanId": theNote.loanId,
      "orderId": theNote.orderId,
      "noteId": theNote.noteId,
      "askingPrice": calcAskPrice(theNote, markup),
    }];
    this.sellNotes(notesToSell);
  }

  getNotes() {
    return new Promise((resolve, reject) => {
      lc.accounts.detailedNotes(this.investorId, (err, ret) => {
        if (err || !ret || !ret.myNotes) {
          reject(new Error('getNotes failed: ' + err));
        } else {
          resolve(ret.myNotes);
        }
      });
    });
  }

  sellNotesAtOptimalMarkup(notes, acceptableYTM, acceptableMarkup) {
    return new Promise((resolve, reject) => {
      try {
        console.log('Filtering from %d notes...', notes.length);
        const filteredNotes = filterSellableNotes(notes, acceptableYTM, acceptableMarkup);
        console.log('Selling %d notes...', filteredNotes.length);
        console.log(' > at ytm=%d, markup=%d', acceptableYTM, acceptableMarkup);
        // let table = makeTable(filteredNotes, acceptableYTM);
        // console.log(table.toString());
        let foliofnSellNotes = convertNotesToFolioSellSchema(filteredNotes);
        if (foliofnSellNotes.length === 0) {
          resolve(filteredNotes);
        } else {
          this.sellNotes(foliofnSellNotes).then((ret) => {
            if(ret.sellNoteStatus === 'SUCCESS') {
              console.log('Sold %d notes...(%d confirmation) (%s)',
                          filteredNotes.length,
                          ret.sellNoteConfirmations.length,
                          ret.sellNoteStatus);
              resolve(filteredNotes);
            } else {
              console.log('Failed to sell %d notes...(%d confirmation) (%s)',
                          filteredNotes.length,
                          ret.sellNoteConfirmations.length,
                          ret.sellNoteStatus);
              reject(new Error('Failed to sell notes, see ret: ' + ret));
            }
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  withdrawFunds(cash) {
    console.log("Going to Withdraw: " + cash);
    const now = new Date();
    const estimatedFundsTransferStartDate = dateFormat(now, "mm/dd/yyyy");
    lc.accounts.funds.withdraw(
        this.investorId, cash, estimatedFundsTransferStartDate,
        (err, ret) => {
          if (err) {
            console.log('error: ' + JSON.stringify(err));
            return;
          }
          console.log(JSON.stringify(ret));
        });
  }

  getAvailableFunds(cb) {
    lc.accounts.summary(this.investorId, (err, ret) => {
      if (err) {
        console.log('error: ' + JSON.stringify(err));
        return;
      }
      console.log("> " + JSON.stringify(ret));
      cb(ret.availableCash);
    });
  }

} // class Client


/* = = = = = = = = = = = = = = = = = = = */

const sellPollHandler = () => {
  // see settings in ./config/*.json
  console.log("> sellPollHandler starting...");
  const client = new Client(config.get('investor.apiKey'),
                            config.get('investor.id'));

  client.getNotes().then((notes) => {
    let nc = new NoteCollection(notes);
    const minYTM = config.get('transaction.acceptableYTM');
    const minMrk = config.get('transaction.acceptableMarkup');
    // const theNotes = nc.byPurpose('Credit card refinancing');
    // const theNotes = nc.byLoanStatus('Late (31-120 days)');
    console.log('Notes: ' + notes.length);

    // sell notes oldest to newest, at an increasing markup
    const monthsIssued = [1, 4, 8];
    let promises = [];
    for (var i = 2; i >= 0; --i) {
      notes = nc.byMonthsIssued(monthsIssued[i]);
      let p = client.sellNotesAtOptimalMarkup(notes,
          minYTM-(i*0.0080),
          minMrk-(i*0.0030))
        .catch((err) => {});
      promises.push(p);
      nc = new NoteCollection(nc.difference(notes));
    }
    (async () => {
      await Promise.all(promises);
      console.log('Done. Waiting for trigger...');
    })();
  });
};

const sellPoller = function() {
  console.log("Selling... every 3 days");
  sellPollHandler();
  setInterval(sellPollHandler, Days(3));
};

const withdrawPollHandler = function() {
  console.log("> withdrawPollHandler");
  const client = new Client(config.get('investor.apiKey'),
                            config.get('investor.id'));
  client.getAvailableFunds((cash) => {
    if (cash > 150) {
      client.withdrawFunds(cash);
    }
  });
};
const withdrawPoller = function() {
  console.log("Withdrawing... every 12 hours");
  withdrawPollHandler();
  setInterval(withdrawPollHandler, Hours(24));
};


/* = = = = = = = = = = = = = = = = = = = */

(function main() {
  const loadAvg = os.loadavg();
  const tm = os.totalmem();
  const fm = os.freemem();
  const pm = fm / tm;
  console.log(os.networkInterfaces());
  console.log(os.cpus());
  console.log('(mem, freemem, %free) : (' + tm + ', ' + fm + ', ' + pm + ')');
  console.log('loadAvg: ' + loadAvg);

  try {
    sellPoller();
    // withdrawPoller();
  } catch (err) {
    console.log("Encountered Error Trying to Sell: " + err);
  }

  // Wanting to use a promise scheme for polling.
  // But.. need to measure the overhead vs just setInterval..
  // withdrawPoller();
  // async function loop() {
  //   function sleep(ms) {
  //     return new Promise(resolve => setTimeout(resolve, ms));
  //   }
  //   await sleep(Hours(6)).then(loop);
  // }
}());
