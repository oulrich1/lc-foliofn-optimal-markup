/*jshint esversion: 6 */
/*jslint node: true */
"use strict";

const Table = require('cli-table');
const dateFormat = require('dateformat');
const findRoot = require('newton-raphson');
const extend = require('util')._extend;
const lc = require('node-lending-club-api');
const config = require('config');

lc.init({ apiKey: config.get('investor.apiKey') });
const investorId = config.get('investor.id');

function getMaxExpirationDate() {
  const days = 7;
  var now = new Date();
  now.setDate(now.getDate() + days);
  return dateFormat(now, "mm/dd/yyyy");
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
function calcMonthlyPayment(principal, remainingPayments,
                            interestRatePerPayment) {
  // http://forum.lendacademy.com/index.php?topic=4192.0
  const p = principal;
  const n = remainingPayments;
  const r = interestRatePerPayment;
  return p*((r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1));
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

  const n = params.remainingPayments;  // number of remaining payments
  const pr = params.askPrice;          // maybe or not the same as principalPending

  const f = function(r) {
    return m - calcMonthlyPayment(pr,n,r);
  };
  const fprime = function(r) {
    const h = 0.001; // almost forgot the h again..
    return (f(r+h,m,pr,n)-f(r,m,pr,n))/h;
  };

  const initialRateGuesstimate = 1.0;
  return findRoot(f, fprime, initialRateGuesstimate) * 12;
}

function calcAskingPrice(theNote, markup) {
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
  function isValidMarkup(markup) {
    return (markup > 0.01 && markup < 0.7);
  }
  function isValidYTM(ytm) {
    return ytm > 0.0495; // is good for the buyer
  }

  const initialAskPrice = calcAskingPrice(theNote, initialMarkup);
  const remainingPayments = 12; // calcRemainingPayments(theNote.loanLength, theNote.dateIssued);
  const interestRate = theNote.interestRate / 100 / 12;
  let params = {
    monthlyPayment : calcMonthlyPayment(theNote.principalPending,
                                        remainingPayments, interestRate),
    remainingPayments : remainingPayments,
    askPrice : initialAskPrice
  };

  const g = function(markup) {
    let paramsCopy = extend({}, params);
    paramsCopy.askPrice = calcAskingPrice(theNote, markup);
    const val =  acceptableYTM - calcYield(paramsCopy);
    // console.log('g  : ' + val);
    return val;
  };

  const gprime = function(markup) {
    const h = 0.001; // almost forgot the h again..
    const delta = (g(markup+h) - g(markup)) / h;
    // console.log('g` : ' + delta);
    return delta;
  };

  return findRoot(g, gprime, initialMarkup);
}


// https://www.lendingclub.com/foliofn/folioInvestingAPIDocument.action
const client = {

  buyNotes : function(notesToBuy) {
    lc.folio.buy(investorId, notesToBuy,
      function(err, ret) {
        if (err) {
          console.log('Error: ' + err);
          return;
        }
        console.log(ret);
    });
  },

  // param notesToSell is an array of objects containing:
  //   objects that follow the foliofn sell schema
  sellNotes : function(notesToSell) {
    lc.folio.sell(investorId, getMaxExpirationDate(), notesToSell,
      function(err, ret) {
        if (err) {
          console.log('Error: ' + err);
          return;
        }
        console.log(ret);
    });
  },

  // Sells one note at a markup on foliofn (lending club)
  // multiple calls within a second will be 500'd
  // Use this sparingly
  sellNoteAtMarkup : function(theNote, markup) {
    // console.log('Selling note: ' + theNote.noteId + ' at markup: ' + markup);
    if (markup < 0.01 || markup >= 0.70) {
      throw Error('Sale was attempted on note: ' + theNote.noteId +
                  ' at invalid markup: ' + markup);
    }
    const notesToSell = [ {
      "loanId" : theNote.loanId,
      "orderId" : theNote.orderId,
      "noteId" : theNote.noteId,
      "askingPrice" : calcAskingPrice(theNote, markup),
    } ];
    sellNotes(notesToSell);
  }
};

// creates an array of objects that follow the foliofn
// 'sell' endpoint request data schema
// requires param 'theSellNotes' to follow schema:
//   [{theNote: lendingClubNote, askPrice: askPrice}]
function convertNotesToFolioSellSchema(theSellNotes) {
  let notesToSell = [];
  for (var i = 0; i < theSellNotes.length; ++i) {
    const theNote = theSellNotes[i].theNote;
    const askPrice = theSellNotes[i].askPrice;
    // console.log('Selling note: ' + theNote.noteId + ' at askPrice: ' +
    //             askPrice + ' markup: ' +
    //             askPrice / theNote.principalPending);
    if (askPrice < theNote.principalPending) {
      throw Error('Sale was attempted on note: ' + theNote.noteId +
                  ' at invalid askPrice: ' + askPrice);
    }
    notesToSell.push({
      "loanId" : theNote.loanId,
      "orderId" : theNote.orderId,
      "noteId" : theNote.noteId,
      "askingPrice" : askPrice,
    });
  }
  return notesToSell;
}

class NoteCollection {
  constructor(rawNotes) {
    this.notes = rawNotes;
  }
  // targetId must be an integer
  byId(targetId) {
    return this.notes.find(function(note){
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
  };
}

function filterSellableNotes(theNotes, acceptableYTM, acceptableMarkup) {
  let notesToSell = [];
  const table = new Table({
    head : [
      'noteId', 'initialMarkup', 'finalMarkup', 'initialAskingPrice',
      'finalAskingPrice', 'initialYTM', 'finalYTM'
    ],
    colWidths : [ 14, 12, 12, 12, 12, 12, 12 ]
  });
  const arrayLength = theNotes.length;
  for (let i = 0; i < arrayLength; i++) {
    const theNote = theNotes[i];
    const initialMarkup = 0.011;

    const monthlyPayment = calcMonthlyPayment(theNote.principalPending, 12,
                                              theNote.interestRate / 100 / 12);

    let params = {
      monthlyPayment : monthlyPayment,
      remainingPayments : 12,
      askPrice : calcAskingPrice(theNote, initialMarkup)
    };
    let initialYTM = calcYield(params);

    /* Finds the markup such that we reach an acceptable YTM for that markup
    * */
    let markup = calcOptimalMarkup(theNote, initialMarkup, acceptableYTM);
    if (markup && markup > acceptableMarkup) {
      const askPrice = calcAskingPrice(theNote, markup);
      params = {
        monthlyPayment : monthlyPayment,
        remainingPayments : 12,
        askPrice : askPrice
      };
      let finalYTM = calcYield(params);

      if (askPrice >= theNote.principalPending) {
        notesToSell.push({
          theNote : theNote,
          askPrice : askPrice,
        });

        const viewObject = [
          theNote.noteId,
          initialMarkup,
          roundNumber(markup, 4),
          roundNumber(calcAskingPrice(theNote, initialMarkup), 2),
          roundNumber(askPrice, 2),
          roundNumber(initialYTM, 4),
          roundNumber(finalYTM, 4),
        ];
        table.push(viewObject);
      }
    }
  }
  return {notesToSell: notesToSell, table: table};
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

lc.accounts.detailedNotes(investorId, function(err, ret) {
  if (err) {
    console.log('error: ' + err);
    return;
  }

  const notes = new NoteCollection(ret.myNotes);

  /*
    * purpose: 'Credit card refinancing'
    * */
  const creditNotes = notes.byPurpose('Credit card refinancing');

  // filter out the ones that should not be sold
  // keep a list of notes to sell with optimal askPrice
  let acceptableYTM = 0.0595;
  let acceptableMarkup = 0.04;
  let sellable = filterSellableNotes(creditNotes, acceptableYTM, acceptableMarkup);
  let notesToSell = sellable.notesToSell;
  let table = sellable.table;

  console.log(table.toString());
  console.log('Selling %d notes...', notesToSell.length);
  let foliofnSellNotes = convertNotesToFolioSellSchema(notesToSell);
  // client.sellNotes(foliofnSellNotes);


  /*
   *  loanStatus: 'Late (16-30 days)'
   *  loanStatus: 'Late (31-120 days)'
    * */
  // const lateNotes = notes.byLoanStatus('Late (31-120 days)');

  // acceptableYTM = 0.0695;
  // sellable = filterSellableNotes(lateNotes, acceptableYTM);
  // notesToSell = sellable.notesToSell;
  // table = sellable.table;

  // console.log(table.toString());
  // console.log('Selling %d notes...', notesToSell.length);
  // foliofnSellNotes = convertNotesToFolioSellSchema(notesToSell);
});



  /* * * * * * * * * * * *
   * Determine what a basic note looks like
  */
  /*
  const theNote = notes.byId(noteId);
  console.log('NOTE: %j', theNote);
  */
