/**
 * Service-layer tests for `moveCardToBoard`. Exercises the policy edges
 * documented in the planning doc and PR #16:
 *
 *   - Reject if the card has children
 *   - Sever the parent link on move (parent stays on source board)
 *   - Drop label memberships (labels are board-scoped by name)
 *   - Dense-shift the source column to close the gap
 *   - Append at the end of the destination column
 *   - Optimistic-concurrency on `expectedVersion`
 *   - Reject same-board "moves" (defensive — the UI excludes this)
 *   - Reject unknown destination column
 *
 * Run with `npm test`. Uses the in-memory D1 mock in tests/helpers/.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDb,
  FakeD1,
  makeBoard,
  makeCard,
  attachLabel,
  resetIdCounters,
  type FakeDb,
} from './helpers/d1_memory.ts';
import {
  moveCardToBoard,
  MoveCardToBoardError,
} from '../src/services/kanban.service.ts';

let db: FakeDb;
let d1: FakeD1;

function setup(): { boardA: number; boardB: number } {
  resetIdCounters();
  db = emptyDb();
  d1 = new FakeD1(db);
  const a = makeBoard(db, { name: 'A' });
  const b = makeBoard(db, { name: 'B' });
  return { boardA: a.id as number, boardB: b.id as number };
}

describe('moveCardToBoard', () => {
  beforeEach(() => setup());

  it('moves a basic card and reports no dropped labels / no severed parent', async () => {
    const { boardA, boardB } = setup();
    const card = makeCard(db, { boardId: boardA, column: 'started', title: 'plain' });

    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      card.id as number,
      boardB,
      'ready',
      card.version as number,
      999
    );

    assert.ok(result, 'should return a result');
    assert.equal(result!.card.boardId, boardB);
    assert.equal(result!.card.column, 'ready');
    assert.equal(result!.card.position, 0);
    assert.deepEqual(result!.droppedLabels, []);
    assert.equal(result!.severedParent, false);
  });

  it('drops label memberships and reports them in droppedLabels', async () => {
    const { boardA, boardB } = setup();
    const card = makeCard(db, { boardId: boardA });
    attachLabel(db, card.id as number, 'urgent');
    attachLabel(db, card.id as number, 'q3');

    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      card.id as number,
      boardB,
      'not_started',
      card.version as number,
      null
    );

    assert.ok(result);
    assert.deepEqual(result!.droppedLabels.sort(), ['q3', 'urgent']);
    // Confirm the join rows are actually gone.
    assert.equal(
      db.cardGroups.filter((r) => r.card_id === card.id).length,
      0,
      'card_groups rows should be deleted on move'
    );
  });

  it('severs the parent link on move (parent stays on source board)', async () => {
    const { boardA, boardB } = setup();
    const parent = makeCard(db, { boardId: boardA, title: 'parent' });
    const child = makeCard(db, {
      boardId: boardA,
      title: 'child',
      parentCardId: parent.id as number,
    });

    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      child.id as number,
      boardB,
      'not_started',
      child.version as number,
      null
    );

    assert.ok(result);
    assert.equal(result!.severedParent, true);
    assert.equal(result!.card.parentCardId, null);
    // Parent stays put on the source board.
    const parentRow = db.cards.find((r) => r.id === parent.id);
    assert.equal(parentRow!.board_id, boardA);
  });

  it('rejects when the card has active children', async () => {
    const { boardA, boardB } = setup();
    const parent = makeCard(db, { boardId: boardA });
    makeCard(db, { boardId: boardA, parentCardId: parent.id as number });

    await assert.rejects(
      moveCardToBoard(
        d1 as unknown as D1Database,
        parent.id as number,
        boardB,
        'not_started',
        parent.version as number,
        null
      ),
      (err: unknown) =>
        err instanceof MoveCardToBoardError && err.reason === 'has_children'
    );
  });

  it('allows the move when the only child is archived', async () => {
    const { boardA, boardB } = setup();
    const parent = makeCard(db, { boardId: boardA });
    makeCard(db, {
      boardId: boardA,
      parentCardId: parent.id as number,
      archived: true,
    });

    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      parent.id as number,
      boardB,
      'done',
      parent.version as number,
      null
    );
    assert.ok(result, 'archived children should not block the move');
  });

  it('dense-shifts the source column after the move', async () => {
    const { boardA, boardB } = setup();
    const a = makeCard(db, { boardId: boardA, column: 'started', position: 0 });
    const b = makeCard(db, { boardId: boardA, column: 'started', position: 1 });
    const c = makeCard(db, { boardId: boardA, column: 'started', position: 2 });
    // Move the middle one (`b`) to board B.
    await moveCardToBoard(
      d1 as unknown as D1Database,
      b.id as number,
      boardB,
      'not_started',
      b.version as number,
      null
    );
    const aRow = db.cards.find((r) => r.id === a.id)!;
    const cRow = db.cards.find((r) => r.id === c.id)!;
    assert.equal(aRow.position, 0, 'card a stays at position 0');
    assert.equal(cRow.position, 1, 'card c slides up from 2 → 1');
  });

  it('appends at the end of the destination column', async () => {
    const { boardA, boardB } = setup();
    // Pre-populate destination column with two cards.
    makeCard(db, { boardId: boardB, column: 'approval', position: 0 });
    makeCard(db, { boardId: boardB, column: 'approval', position: 1 });
    const movee = makeCard(db, { boardId: boardA });

    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      movee.id as number,
      boardB,
      'approval',
      movee.version as number,
      null
    );

    assert.ok(result);
    assert.equal(result!.card.position, 2, 'should land at end of dest column');
  });

  it('returns null on version conflict', async () => {
    const { boardA, boardB } = setup();
    const card = makeCard(db, { boardId: boardA, version: 5 });
    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      card.id as number,
      boardB,
      'not_started',
      4, // stale
      null
    );
    assert.equal(result, null);
  });

  it('returns null when the card does not exist', async () => {
    const { boardB } = setup();
    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      99999,
      boardB,
      'not_started',
      1,
      null
    );
    assert.equal(result, null);
  });

  it('rejects when target board is the same as the current board', async () => {
    const { boardA } = setup();
    const card = makeCard(db, { boardId: boardA });
    await assert.rejects(
      moveCardToBoard(
        d1 as unknown as D1Database,
        card.id as number,
        boardA,
        'not_started',
        card.version as number,
        null
      ),
      (err: unknown) => err instanceof MoveCardToBoardError && err.reason === 'same_board'
    );
  });

  it('rejects when target board does not exist', async () => {
    const { boardA } = setup();
    const card = makeCard(db, { boardId: boardA });
    await assert.rejects(
      moveCardToBoard(
        d1 as unknown as D1Database,
        card.id as number,
        99999,
        'not_started',
        card.version as number,
        null
      ),
      (err: unknown) => err instanceof MoveCardToBoardError && err.reason === 'unknown_board'
    );
  });

  it('rejects when target column does not exist on the destination', async () => {
    const { boardA, boardB } = setup();
    const card = makeCard(db, { boardId: boardA });
    await assert.rejects(
      moveCardToBoard(
        d1 as unknown as D1Database,
        card.id as number,
        boardB,
        'nonexistent_column',
        card.version as number,
        null
      ),
      (err: unknown) => err instanceof MoveCardToBoardError && err.reason === 'unknown_column'
    );
  });

  it('refuses to move an archived card (returns null)', async () => {
    const { boardA, boardB } = setup();
    const card = makeCard(db, { boardId: boardA, archived: true });
    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      card.id as number,
      boardB,
      'not_started',
      card.version as number,
      null
    );
    assert.equal(result, null);
  });

  it('returns sourcePositions and destPositions for the touched columns', async () => {
    const { boardA, boardB } = setup();
    const stay = makeCard(db, { boardId: boardA, column: 'started', position: 0 });
    const movee = makeCard(db, { boardId: boardA, column: 'started', position: 1 });
    const destExisting = makeCard(db, { boardId: boardB, column: 'done', position: 0 });

    const result = await moveCardToBoard(
      d1 as unknown as D1Database,
      movee.id as number,
      boardB,
      'done',
      movee.version as number,
      null
    );

    assert.ok(result);
    // Source: just the staying card.
    assert.equal(result!.sourcePositions.length, 1);
    assert.equal(result!.sourcePositions[0].id, stay.id);
    // Dest: existing + the moved one.
    const ids = result!.destPositions.map((p) => p.id).sort();
    assert.deepEqual(ids, [destExisting.id as number, movee.id as number].sort());
  });
});
