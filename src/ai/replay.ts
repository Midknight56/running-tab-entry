// Recorded model answers, keyed like the cache (`job:sha256`), served when the day's budget is spent or the app runs
// in replay mode. Made by `node tools/export-replay.mjs` from a live run's cache; every answer still passes the same
// code checks as a live one.
import data from './replay.json'

export const REPLAY: Record<string, string> = data as Record<string, string>
