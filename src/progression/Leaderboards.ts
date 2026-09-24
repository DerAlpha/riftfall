/**
 * Local leaderboards (ProfileData.leaderboards): the best runs per `${mapId}:${modeId}`, best
 * first, at most PROGRESSION_LIMITS.leaderboardSize entries per board and maxBoards boards.
 *
 * Order: higher wave, then higher score, then more kills; equal runs keep their arrival order
 * (an older run stays ahead of a new one that only ties it).
 */
import type { LeaderboardEntry } from '../core/contracts';
import { PROGRESSION_LIMITS, boardKey } from '../defs/progression';

/** Negative when `a` ranks before `b`. Dates do not order entries (arrival order does). */
export function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  if (a.wave !== b.wave) return b.wave - a.wave;
  if (a.score !== b.score) return b.score - a.score;
  return b.kills - a.kills;
}

export class Leaderboards {
  constructor(
    private boards: Record<string, LeaderboardEntry[]>,
    private readonly size: number = PROGRESSION_LIMITS.leaderboardSize,
    private readonly maxBoards: number = PROGRESSION_LIMITS.maxBoards,
  ) {}

  attach(boards: Record<string, LeaderboardEntry[]>): void {
    this.boards = boards;
  }

  /** Insert a run; returns its 1-based rank, 0 when it did not place. */
  submit(mapId: string, mode: string, entry: LeaderboardEntry): number {
    const key = boardKey(mapId, mode);
    let board = this.boards[key];
    if (!board) {
      if (Object.keys(this.boards).length >= this.maxBoards) return 0;
      board = [];
      this.boards[key] = board;
    }
    // After every entry it does not beat: ties keep the older run first (stable).
    let i = 0;
    while (i < board.length && compareEntries(board[i]!, entry) <= 0) i++;
    if (i >= this.size) return 0;
    board.splice(i, 0, entry);
    if (board.length > this.size) board.length = this.size;
    return i + 1;
  }

  get(mapId: string, mode?: string): readonly LeaderboardEntry[] {
    return this.boards[boardKey(mapId, mode)] ?? [];
  }

  keys(): string[] {
    return Object.keys(this.boards);
  }
}
