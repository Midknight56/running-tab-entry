// Recorded answers from an earlier model, keyed as `job:sha256`, are a fallback in replay mode or when a live call
// cannot answer. Made from a live run's cache; every answer still passes the same code checks as a live one.
import data from './replay.json'

export const REPLAY: Record<string, string> = data as Record<string, string>
