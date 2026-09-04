/* Shared Bonus Mock validation/normalization helpers (MAIN + isolated worlds). */
(function (root) {
  'use strict';

  var FUTURE_EXPIRY = '2050-12-31T23:59:59.000Z';
  var CONFIG_KEY = '__lgtBonusMockV1';
  var LAST_MATCH_KEY = '__lgtBonusMockLastMatchV1';
  var FEATURE_FIELDS = {
    ProfitBoost: 'profitBoostBonusFeature',
    PriceBoost: 'priceBoostBonusFeature',
    AccaBoost: 'accaBoostBonusFeature',
    BetInsurance: 'betInsuranceBonusFeature'
  };
  var SUPPORTED_FEATURES = ['ProfitBoost', 'PriceBoost', 'AccaBoost', 'BetInsurance', 'FreeBet', 'RiskFreeBet'];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validateMock(payload) {
    var errors = [];
    if (!isRecord(payload)) throw new Error('Invalid sportsbook bonus mock: root must be a JSON object');
    if (!isRecord(payload.data)) errors.push('root.data must be an object');
    if (!isRecord(payload.responseContext)) errors.push('root.responseContext must be an object');
    if (typeof payload.responseCode !== 'string' || !payload.responseCode) errors.push('root.responseCode must be a non-empty string');
    if (!Array.isArray(payload.responseResults)) errors.push('root.responseResults must be an array');
    var bonuses = payload.data && payload.data.bonuses;
    var mappings = payload.data && payload.data.mappings;
    if (!isRecord(bonuses)) errors.push('root.data.bonuses must be an object');
    if (!isRecord(mappings)) errors.push('root.data.mappings must be an object');
    if (errors.length) throw new Error('Invalid sportsbook bonus mock: ' + errors.join('; '));

    var featureCounts = {};
    var bonusIds = Object.keys(bonuses);
    var bonusSet = {};
    bonusIds.forEach(function (id) { bonusSet[id] = true; });
    bonusIds.forEach(function (key) {
      var bonus = bonuses[key];
      var prefix = 'bonus ' + key;
      if (!isRecord(bonus)) { errors.push(prefix + ' must be an object'); return; }
      if (bonus.id !== key) errors.push(prefix + '.id must equal its object key');
      if (typeof bonus.name !== 'string' || !bonus.name.trim()) errors.push(prefix + '.name must be a non-empty string');
      if (!Array.isArray(bonus.features) || !bonus.features.length) {
        errors.push(prefix + '.features must be a non-empty array');
      } else {
        bonus.features.forEach(function (feature) {
          if (SUPPORTED_FEATURES.indexOf(feature) === -1) errors.push(prefix + ' has unsupported feature ' + JSON.stringify(feature));
          featureCounts[feature] = (featureCounts[feature] || 0) + 1;
          var field = FEATURE_FIELDS[feature];
          if (field && !isRecord(bonus[field])) errors.push(prefix + ' (' + feature + ') requires ' + field);
        });
      }
      if (typeof bonus.expiryDate !== 'string' || isNaN(Date.parse(bonus.expiryDate))) errors.push(prefix + '.expiryDate must be a date string');
      if (!isRecord(bonus.betConditions)) errors.push(prefix + '.betConditions must be an object');
      if (!isRecord(bonus.uptakeConditions)) errors.push(prefix + '.uptakeConditions must be an object');
      if (typeof bonus.payoutType !== 'string' || !bonus.payoutType) errors.push(prefix + '.payoutType must be a non-empty string');
      if (bonus.features && bonus.features.some(function (feature) { return feature === 'FreeBet' || feature === 'RiskFreeBet'; })) {
        var limits = bonus.betConditions && bonus.betConditions.betStakeLimits;
        if (!isRecord(limits) || !Object.keys(limits).length) errors.push(prefix + ' requires non-empty betConditions.betStakeLimits');
      }
    });

    var mappingReferenceCount = 0;
    Object.keys(mappings).forEach(function (mappingType) {
      var entityMap = mappings[mappingType];
      if (!isRecord(entityMap)) { errors.push('mapping ' + mappingType + ' must be an object'); return; }
      if (mappingType === 'featureToMarket') {
        Object.keys(entityMap).forEach(function (feature) {
          var categoryMap = entityMap[feature];
          if (!isRecord(categoryMap)) { errors.push('mapping featureToMarket.' + feature + ' must be an object'); return; }
          Object.keys(categoryMap).forEach(function (categoryId) {
            var marketIds = categoryMap[categoryId];
            if (!Array.isArray(marketIds)) { errors.push('mapping featureToMarket.' + feature + '.' + categoryId + ' must be an array'); return; }
            marketIds.forEach(function (marketId) {
              var market = mappings.marketId && mappings.marketId[marketId];
              if (!market) errors.push('mapping featureToMarket.' + feature + '.' + categoryId + ' points to missing market ' + marketId);
              else if (!Array.isArray(market[feature])) errors.push('market ' + marketId + ' does not declare feature ' + feature);
            });
          });
        });
        return;
      }
      Object.keys(entityMap).forEach(function (entityId) {
        var featureMap = entityMap[entityId];
        if (!isRecord(featureMap)) { errors.push('mapping ' + mappingType + '.' + entityId + ' must be an object'); return; }
        Object.keys(featureMap).forEach(function (feature) {
          var ids = featureMap[feature];
          if (!Array.isArray(ids)) { errors.push('mapping ' + mappingType + '.' + entityId + '.' + feature + ' must be an array'); return; }
          ids.forEach(function (id) {
            mappingReferenceCount += 1;
            if (!bonusSet[id]) errors.push('mapping ' + mappingType + '.' + entityId + '.' + feature + ' points to missing bonus ' + id);
            else if (bonuses[id].features.indexOf(feature) === -1) errors.push('mapping feature ' + feature + ' does not match bonus ' + id);
          });
        });
      });
    });
    if (errors.length) throw new Error('Invalid sportsbook bonus mock: ' + errors.join('; '));
    return { bonusCount: bonusIds.length, featureCounts: featureCounts, mappingReferenceCount: mappingReferenceCount };
  }

  function prepareMock(payload, expiryPolicy) {
    expiryPolicy = expiryPolicy || 'future';
    if (expiryPolicy !== 'future' && expiryPolicy !== 'preserve') throw new Error('expiryPolicy must be "future" or "preserve"');
    validateMock(payload);
    var prepared = JSON.parse(JSON.stringify(payload));
    if (expiryPolicy === 'future') {
      Object.keys(prepared.data.bonuses).forEach(function (id) { prepared.data.bonuses[id].expiryDate = FUTURE_EXPIRY; });
    }
    validateMock(prepared);
    return prepared;
  }

  function hasResponseShape(payload) {
    return isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.bonuses) && isRecord(payload.data.mappings);
  }

  function hasWidgetResponseShape(payload) {
    return isRecord(payload) && isRecord(payload.data) && isRecord(payload.skeleton) &&
      Array.isArray(payload.skeleton.marketDetailsQueries) && typeof payload.referenceId === 'string';
  }

  function optionalNumber(value, fallback) {
    return typeof value === 'number' ? value : fallback;
  }

  function mapPayoutType(value) {
    return value === 'PayAsBonusMoney' ? 'BonusMoney' : 'RealMoney';
  }

  function mapEntityDetails(mapping) {
    var detail = {};
    [
      ['category', 'categoryId'], ['competition', 'competitionId'], ['event', 'eventId'],
      ['market', 'marketId'], ['marketSelection', 'marketSelectionId']
    ].forEach(function (field) {
      var entity = mapping && mapping[field[0]];
      if (entity && typeof entity.navigationEntityId === 'string') detail[field[1]] = entity.navigationEntityId;
    });
    if (Array.isArray(mapping && mapping.marketTemplates) && mapping.marketTemplates.length) {
      detail.marketTemplateIds = mapping.marketTemplates.map(function (template) {
        return typeof template === 'string' ? template : template && template.navigationEntityId;
      }).filter(Boolean);
    }
    return detail;
  }

  function mapConditions(bonus) {
    var input = bonus.betConditions || {};
    var selection = input.selectionConditions || {};
    var count = input.selectionsCountLimit || {};
    var stakes = input.betStakeLimits || {};
    var stake = stakes.EUR || stakes.eur || stakes[Object.keys(stakes)[0]] || {};
    var criteria = input.selectionsEligibility && input.selectionsEligibility.criteria;
    var combined = selection.combinedBetSelectionConditions || {};
    var combinedCount = selection.combinedSelectionsCountLimit || {};
    var conditions = {
      betTypes: Array.isArray(input.allowedBetTypes) ? input.allowedBetTypes.slice() : [],
      minimumStake: optionalNumber(stake.min, 0),
      maximumStake: optionalNumber(stake.max, Number.MAX_SAFE_INTEGER),
      oddsLimit: {
        minOdds: optionalNumber(input.betOddsLimit && input.betOddsLimit.min, 0),
        maxOdds: optionalNumber(input.betOddsLimit && input.betOddsLimit.max, Number.MAX_SAFE_INTEGER)
      },
      minimumNumberOfSelections: optionalNumber(count.min, 1),
      maximumNumberOfSelections: optionalNumber(count.max, Number.MAX_SAFE_INTEGER),
      allowedBetSelectionTypes: Array.isArray(selection.allowedBetSelectionTypes) ? selection.allowedBetSelectionTypes.slice() : [],
      allSelectionsEligible: criteria === 'AllSelectionsEligible'
    };
    if (isRecord(selection.selectionOddsLimits)) {
      conditions.selectionOddsLimit = {
        minOdds: optionalNumber(selection.selectionOddsLimits.min, 0),
        maxOdds: optionalNumber(selection.selectionOddsLimits.max, Number.MAX_SAFE_INTEGER)
      };
    }
    if (Object.keys(combinedCount).length || Object.keys(combined).length) {
      conditions.combinedSelectionsConditions = {
        combinedSelectionsLimit: {
          minSelections: optionalNumber(combinedCount.min, 0),
          maxSelections: optionalNumber(combinedCount.max, Number.MAX_SAFE_INTEGER)
        },
        combinedSelectionsOddsLimit: {
          minOdds: optionalNumber(combined.selectionOddsLimits && combined.selectionOddsLimits.min, 0),
          maxOdds: optionalNumber(combined.selectionOddsLimits && combined.selectionOddsLimits.max, Number.MAX_SAFE_INTEGER)
        }
      };
    }
    return conditions;
  }

  function amountsByCurrency(amounts) {
    var values = isRecord(amounts) ? amounts : {};
    var euro = optionalNumber(values.EUR, optionalNumber(values.eur, 0));
    var other = {};
    Object.keys(values).forEach(function (currency) {
      if (currency.toUpperCase() !== 'EUR' && typeof values[currency] === 'number') other[currency.toUpperCase()] = values[currency];
    });
    return { euro: euro, other: other };
  }

  function mapBonusData(bonus, feature) {
    var payout = mapPayoutType(bonus.payoutType);
    if (feature === 'PriceBoost') {
      var price = bonus.priceBoostBonusFeature || {};
      var percentage = optionalNumber(price.percentageType && price.percentageType.value, 0);
      return {
        type: price.boostType === 'Percentage' ? 'Multiplier' : 'Fixed',
        boostedOdds: percentage || optionalNumber(price.fixedType && price.fixedType.value, 0),
        isOptedInByDefault: false,
        priceBoostedFormats: {},
        isSuperBoost: !!bonus.isSuperBoost,
        winPayoutMode: payout,
        boostBasedOn: 0
      };
    }
    if (feature === 'ProfitBoost') {
      var profit = bonus.profitBoostBonusFeature || {};
      var profitAmounts = amountsByCurrency(profit.maxBoostedWinnings);
      return {
        profitBoostMultiplier: optionalNumber(profit.percentageValue, 0),
        maxBoostedWinningsInEuro: profitAmounts.euro,
        maxBoostedWinningsInOtherCurrencies: profitAmounts.other
      };
    }
    if (feature === 'AccaBoost') {
      var acca = bonus.accaBoostBonusFeature || {};
      var accaAmounts = amountsByCurrency(acca.maxBoostedWinnings);
      return {
        isOptedInByDefault: false,
        maxBoostedWinningsInEuro: accaAmounts.euro,
        maxBoostedWinningsInOtherCurrencies: accaAmounts.other,
        winPayoutMode: payout,
        selectionBoosts: (acca.selectionLimits || []).map(function (step) {
          return {
            selectionsRangeFrom: optionalNumber(step.limits && step.limits.min, 0),
            selectionsRangeTo: optionalNumber(step.limits && step.limits.max, Number.MAX_SAFE_INTEGER),
            boostMultiplier: optionalNumber(step.percentageValue, 0)
          };
        }),
        boostBasedOn: acca.boostBasedOn || 'TotalWinAmount'
      };
    }
    if (feature === 'BetInsurance') {
      var insurance = bonus.betInsuranceBonusFeature || {};
      var insuranceAmounts = amountsByCurrency(insurance.maximumPayout);
      return {
        maximumLosingSelectionsCount: optionalNumber(insurance.maxLosingSelectionsCount, 1),
        isOptedInByDefault: false,
        maximumPayout: insuranceAmounts.euro
      };
    }
    var stakeLimits = bonus.betConditions && bonus.betConditions.betStakeLimits || {};
    var stake = stakeLimits.EUR || stakeLimits.eur || stakeLimits[Object.keys(stakeLimits)[0]] || {};
    return { stake: optionalNumber(stake.max, optionalNumber(stake.min, 0)), winPayoutMode: payout };
  }

  function toWidgetPayload(payload, original) {
    validateMock(payload);
    var bonuses = [];
    var markets = {};
    Object.keys(payload.data.bonuses).forEach(function (id) {
      var source = payload.data.bonuses[id];
      (source.features || []).forEach(function (feature) {
        var entityMappings = source.uptakeConditions && source.uptakeConditions.entityMapping &&
          source.uptakeConditions.entityMapping.navigationEntityMappings || [];
        var details = entityMappings.map(mapEntityDetails);
        details.forEach(function (detail) { if (detail.marketId) markets[detail.marketId] = true; });
        var properties = source.uptakeConditions && source.uptakeConditions.entityProperties || {};
        bonuses.push({
          id: source.id,
          name: source.name,
          type: feature,
          expiryDate: source.expiryDate,
          criteria: {
            eventPhases: Array.isArray(properties.eventPhases) ? properties.eventPhases.slice() : [],
            marketTemplateIds: Array.isArray(properties.marketTemplates) ? properties.marketTemplates.slice() : [],
            criteriaEntityDetails: details
          },
          conditions: mapConditions(source),
          bonusData: mapBonusData(source, feature),
          isPersonal: false
        });
      });
    });
    return {
      skeleton: { marketDetailsQueries: Object.keys(markets).length ? [Object.keys(markets).join(',')] : [] },
      data: { pollingInterval: 0, bonuses: bonuses },
      referenceId: original && typeof original.referenceId === 'string' ? original.referenceId : 'lgt-bonus-mock'
    };
  }

  function matchesEndpoint(url) {
    try { return /(?:^|[\/?#_.-])(?:global)?bonuses?(?:[\/?#_.-]|$)/i.test(new URL(String(url), location.href).href); }
    catch (e) { return false; }
  }

  root.LgtBonusMock = {
    CONFIG_KEY: CONFIG_KEY,
    LAST_MATCH_KEY: LAST_MATCH_KEY,
    FUTURE_EXPIRY: FUTURE_EXPIRY,
    hasResponseShape: hasResponseShape,
    hasWidgetResponseShape: hasWidgetResponseShape,
    matchesEndpoint: matchesEndpoint,
    prepareMock: prepareMock,
    toWidgetPayload: toWidgetPayload,
    validateMock: validateMock
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
