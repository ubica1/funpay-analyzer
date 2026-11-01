import { selectedCategoryIds } from "./platforms.mjs";
// A completed attempt is separate from a saved snapshot. In particular, an
// error must never move the snapshot date forward or hide the previous data.
export function freshness(db, query, displayedSnapshots) {
  const displayed = new Map(
    displayedSnapshots.map((s) => [s.category_id, s.collected_at]),
  );
  return selectedCategoryIds(db, query).map((id) => {
    const category = db
      .prepare("SELECT id,name,platform FROM categories WHERE id=?")
      .get(id);
    const snapshot = db
      .prepare("SELECT MAX(collected_at) at FROM snapshots WHERE category_id=?")
      .get(id);
    const attempt = db
      .prepare(
        "SELECT id,started_at,status,message FROM runs WHERE category_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(id);
    return {
      ...category,
      displayedAt: displayed.get(id) ?? null,
      latestSnapshotAt: snapshot.at ?? null,
      lastAttempt: attempt ?? null,
      failed:
        attempt?.status === "error" &&
        (!snapshot.at || attempt.started_at >= snapshot.at),
    };
  });
}
