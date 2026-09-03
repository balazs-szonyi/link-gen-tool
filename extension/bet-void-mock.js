/* Shared Bet Void Mock helpers (MAIN + isolated worlds).
 *
 * Narrow-scope local response override for the sportsbook Bet History
 * "coupon-history" widget: lets a tester mark one or more legs of an
 * existing (real) coupon as Void while deliberately leaving that
 * coupon's boostedOdds/bonusBetType fields untouched - reproducing the
 * observed Price-Boost-Bet-Builder frontend bug (backend correctly
 * recalculates totalOdds/payout after a void, but the stale Price Boost
 * badge/odds keep rendering). This is a read-only, tab+origin-scoped
 * browser-side substitution: it never mutates the real backend/coupon.
 */
(function (root) {
  'use strict';

  var CONFIG_KEY = '__lgtBetVoidMockV1';
  var LAST_SEEN_KEY = '__lgtBetVoidMockLastSeenV1';
  var LAST_MATCH_KEY = '__lgtBetVoidMockLastMatchV1';
  var MAX_SEEN_COUPONS = 30;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasResponseShape(payload) {
    return isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.coupons);
  }

  function matchesEndpoint(url) {
    try { return /coupon-history\/v1/i.test(new URL(String(url), location.href).pathname); }
    catch (e) { return false; }
  }

  // A coupon's voidable "legs" live in different places depending on bet
  // type: a BetBuilder coupon has ONE outer `selections[0]` entry whose
  // `combinedMarketSelections` array holds the real per-market legs
  // (matching `betBuilderSelectionLabels` by index); any other bet type
  // (Single/System/...) just uses the outer `selections` array directly,
  // one leg per selection.
  function legsForCoupon(coupon) {
    var systemBet = coupon && coupon.systemBet;
    var selections = (systemBet && Array.isArray(systemBet.selections)) ? systemBet.selections : [];
    if (!selections.length) return [];
    var isBetBuilder = coupon.type === 'BetBuilder' && Array.isArray(selections[0].combinedMarketSelections) && selections[0].combinedMarketSelections.length;
    if (isBetBuilder) {
      var labels = selections[0].betBuilderSelectionLabels || [];
      return selections[0].combinedMarketSelections.map(function (leg, index) {
        return {
          legIndex: index,
          label: labels[index] || (leg.marketName + ' - ' + leg.selectionName),
          currentStatus: leg.marketSelectionResultStatus || 'Unknown'
        };
      });
    }
    return selections.map(function (selection, index) {
      return {
        legIndex: index,
        label: (selection.marketName || selection.eventName || 'Selection ' + (index + 1)) + (selection.selectionName ? ' - ' + selection.selectionName : ''),
        currentStatus: selection.status || 'Unknown'
      };
    });
  }

  function summarizeCoupon(coupon) {
    return {
      id: coupon.id,
      type: coupon.type,
      status: coupon.status,
      eventNames: coupon.eventNames || [],
      stake: coupon.stake,
      effectiveStake: coupon.effectiveStake,
      boostedOdds: coupon.boostedOdds,
      totalOdds: coupon.totalOdds,
      bonusBetType: coupon.bonusBetType,
      legs: legsForCoupon(coupon)
    };
  }

  function summarizeCoupons(payload) {
    if (!hasResponseShape(payload)) return [];
    return payload.data.coupons.slice(0, MAX_SEEN_COUPONS).map(summarizeCoupon);
  }

  // Applies the void-leg override to a matching coupon inside a real
  // coupon-history response. `config` shape:
  //   { couponId, legIndices: number[], voidCouponStatus: boolean, correctedOdds: number }
  // Returns { payload, matched, appliedLegCount }. If the coupon isn't
  // present in this particular page/response, the payload is returned
  // unmodified (matched: false) - so a stored config only ever affects
  // pages/responses that actually contain the targeted coupon.
  function applyVoidToCoupon(payload, config) {
    if (!hasResponseShape(payload) || !config || !config.couponId) return { payload: payload, matched: false, appliedLegCount: 0 };
    var cloned = JSON.parse(JSON.stringify(payload));
    var coupon = cloned.data.coupons.filter(function (c) { return String(c.id) === String(config.couponId); })[0];
    if (!coupon) return { payload: payload, matched: false, appliedLegCount: 0 };

    var legIndices = Array.isArray(config.legIndices) ? config.legIndices : [];
    var systemBet = coupon.systemBet;
    var selections = (systemBet && Array.isArray(systemBet.selections)) ? systemBet.selections : [];
    var isBetBuilder = coupon.type === 'BetBuilder' && selections.length && Array.isArray(selections[0].combinedMarketSelections);
    var appliedLegCount = 0;

    if (isBetBuilder) {
      var legs = selections[0].combinedMarketSelections;
      legIndices.forEach(function (index) {
        if (legs[index]) { legs[index].marketSelectionResultStatus = 'Void'; appliedLegCount += 1; }
      });
    } else {
      legIndices.forEach(function (index) {
        if (selections[index]) { selections[index].status = 'Void'; selections[index].voidReason = 'Void'; appliedLegCount += 1; }
      });
    }

    if (config.voidCouponStatus) {
      coupon.status = 'Void';
      selections.forEach(function (selection) {
        selection.status = 'Void';
        selection.voidReason = 'Void';
        // The recalculated (correct) combined odds live at this
        // per-selection level in the real payload shape - update them so
        // the "correct" part of the bug (recalculated total) is
        // reproduced too, while boostedOdds/formattedBoostedOdds below
        // are deliberately left untouched (the actual bug).
        if (typeof config.correctedOdds === 'number') {
          selection.odds = config.correctedOdds;
          selection.formattedOdds = config.correctedOdds.toFixed(2);
        }
      });
      coupon.totalPotentialPayout = 0;
      if (isRecord(coupon.betsStatus)) coupon.betsStatus.void = (coupon.numberOfSelections || selections.length || 1);
    }

    if (typeof config.correctedOdds === 'number') {
      coupon.totalOdds = config.correctedOdds;
      var stakeForPayout = typeof coupon.effectiveStake === 'number' ? coupon.effectiveStake : (coupon.stake || 0);
      coupon.totalPayout = Math.round(config.correctedOdds * stakeForPayout * 100) / 100;
    }
    // boostedOdds / bonusBetType intentionally left untouched here - that
    // staleness is exactly the bug being reproduced.

    return { payload: cloned, matched: true, appliedLegCount: appliedLegCount };
  }

  root.LgtBetVoidMock = {
    CONFIG_KEY: CONFIG_KEY,
    LAST_SEEN_KEY: LAST_SEEN_KEY,
    LAST_MATCH_KEY: LAST_MATCH_KEY,
    hasResponseShape: hasResponseShape,
    matchesEndpoint: matchesEndpoint,
    legsForCoupon: legsForCoupon,
    summarizeCoupon: summarizeCoupon,
    summarizeCoupons: summarizeCoupons,
    applyVoidToCoupon: applyVoidToCoupon
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);