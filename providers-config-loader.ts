
524
525
526
527
528
529
530
531
532
533
534
535
536
537
538
539
540
541
542
543
544
545
546
547
548
549
550
551
552
553
554
555
556
557
558
559
560
561
562
563
564
565
566
567
568
569
570
571
572
573
574
575
576
577
578
579
580
581
582
583
584
585
586
587
588
589
590
591
⌄
⌄
⌄
⌄
⌄
'use strict';
      verified ? Date.now() : (old ? old.last_verified : Date.now()),
      JSON.stringify(history),
      old ? (old.success_count ?? 0) : 0,
      old ? (old.failure_count ?? 0) : 0,
      old ? (old.total_latency ?? 0) : 0,
      Date.now()
    );
  } catch (e: any) { _logError(`Failed to update provider config for ${providerName}`, e); }
}

function rollbackProvider(providerName: string): boolean { 
  try {
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (!row || !row.history) return false;
    let history = [];
    try { history = JSON.parse(row.history); } catch (e: any) { return false; }
    if (history.length === 0) return false;
    const previous = history.pop();
    db.upsertProvider?.run(
      providerName,
      previous.endpoint || null,
      previous.model,
      Date.now(),
      JSON.stringify(history),
      row ? (row.success_count ?? 0) : 0,
      row ? (row.failure_count ?? 0) : 0,
      row ? (row.total_latency ?? 0) : 0,
      Date.now()
    );
    _log(`Rolled back ${providerName} to ${previous.model}`, 'INFO', 'config-loader');
    return true;
  } catch (e: any) { return false; }
}

function getProviderHistory(providerName: string): Array<{endpoint: string | null; model: string; verifiedAt: string}> { 
  try {
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (row && row.history) return JSON.parse(row.history);
  } catch (_e: any) { /* malformed data, skipping */ }
  return [];
}

module.exports = {
  // Core config access
  getProviderConfig,
  updateProviderConfig,
  rollbackProvider,
  getProviderHistory,
  // Discovery
  autoDiscoverModels,
  // Replacement (P8)
  findReplacement,
  registerReplacement,
  // Provider metadata (P4)
  hasRequiredEnvKeys,
  isProviderDisabledByDefault,
  getEnvKeys,
  getFallbackModels,
  getKnownProviders,
  getAvailableProviderNamesSync,
  getProviderDefault,
  // Dynamic models
  DYNAMIC_MODELS: () => ({ ...DYNAMIC_MODELS }),
  // DI
  _injectDependencies,
};
