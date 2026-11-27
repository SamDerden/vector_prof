import assert from 'node:assert/strict';
import test from 'node:test';
import { savedRouteForExport } from '../lib/route-actions.ts';

const session = '11111111-1111-4111-8111-111111111111';
const routeId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const values = new Map([['X-Session-ID', session], ['route', JSON.stringify({ version: 2, stamp: 1, saved: [], completed: [], pending: false })]]);
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) } as Storage;
  const body = { route_id: routeId, version: 2, professionKey: 'prof_001' };
  return { values, storage, body };
}
test('export reads the selected freeze profession and carries owning session', async () => {
  const { storage, body } = fixture();
  const result = await savedRouteForExport({mode:'own'}, 'route', 'prof_001', storage, async (url, init) => {
    assert.match(String(url), /professionKey=prof_001/);
    assert.equal(new Headers(init?.headers).get('X-Session-ID'), session);
    return Response.json(body);
  });
  assert.deepEqual(result, {routeId, version:2});
});
test('pending local changes prevent exporting an old server copy', async () => {
  const { storage, values } = fixture();
  values.set('route', JSON.stringify({version:2, pending:true}));
  await assert.rejects(savedRouteForExport({mode:'own'}, 'route', 'prof_001', storage, async () => { throw new Error('must not fetch'); }), /Дождись сохранения/);
});
test('concurrent edits and mismatched server versions prevent download', async () => {
  for (const change of ['local', 'server', 'profession']) {
    const { storage, values, body } = fixture();
    await assert.rejects(savedRouteForExport({mode:'own'}, 'route', 'prof_001', storage, async () => {
      if(change === 'local') values.set('route', JSON.stringify({version:2, stamp:2, pending:false}));
      if(change === 'server') body.version=3;
      if(change === 'profession') body.professionKey='prof_002';
      return Response.json(body);
    }), /Маршрут изменился/);
  }
});
