import mongoose from 'mongoose';

/**
 * One-time idempotent migration: backfill `zoneCode` on legacy packages
 * that still carry `targetSlotCode` / `sourceSlotCode` (pre-zone schema).
 *
 * Safe to call on every startup — the filter `{ zoneCode: { $exists: false } }`
 * ensures only unmigrated documents are touched; subsequent runs are no-ops.
 */
export async function migratePackageZones(): Promise<void> {
  // Wait until Mongoose reaches `connected` state. `connection.asPromise()`
  // resolves once the underlying driver has finished connecting, so callers
  // can safely access `connection.db` afterward.
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connection.asPromise();
  }

  if (!mongoose.connection.db) {
    throw new Error('Mongoose connection is not ready');
  }
  const collection = mongoose.connection.db.collection('packages');

  // ── Pass 1: documents with a valid targetSlotCode → derive zone from first 2 chars ──
  const pass1 = await collection.updateMany(
    {
      zoneCode: { $exists: false },
      targetSlotCode: { $regex: /^S[1-4]/ },
    },
    [
      {
        $set: {
          zoneCode: { $substrCP: ['$targetSlotCode', 0, 2] },
        },
      },
      { $unset: ['sourceSlotCode', 'targetSlotCode'] },
    ],
  );

  // ── Pass 2: remaining documents with no targetSlotCode → zoneCode: null ──
  const pass2 = await collection.updateMany(
    {
      zoneCode: { $exists: false },
    },
    {
      $set: { zoneCode: null },
      $unset: { sourceSlotCode: '', targetSlotCode: '' },
    },
  );

  console.warn(
    `[migrate-package-zone] done — derived: ${pass1.modifiedCount}, nullified: ${pass2.modifiedCount}`,
  );
}
