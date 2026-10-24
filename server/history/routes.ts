import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { query } from '../db/index.js';
import { HttpError } from '../http.js';

export const historyRouter = Router();
historyRouter.use(requireAuth);

const NOT_FOUND = 'That generation was not found.';

// Every query below is scoped with `user_id = <authenticated user>`. Another
// user's id simply matches no row, and the response is the same 404 as for an id
// that doesn't exist, so ids can't be probed.
function generationId(req: Request): string {
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) throw new HttpError(404, NOT_FOUND);
  return parsed.data;
}

historyRouter.get('/', async (req, res) => {
  const items = await query(
    `SELECT id, created_at AS "createdAt", model, left(source_text, 180) AS preview
       FROM generations
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [currentUser(req).id]
  );
  res.json({ items });
});

historyRouter.get('/:id', async (req, res) => {
  const [item] = await query(
    `SELECT id, created_at AS "createdAt", model, source_text AS "sourceText", tweets
       FROM generations
      WHERE id = $1 AND user_id = $2`,
    [generationId(req), currentUser(req).id]
  );
  if (!item) throw new HttpError(404, NOT_FOUND);
  res.json({ item });
});

historyRouter.delete('/:id', async (req, res) => {
  const deleted = await query(`DELETE FROM generations WHERE id = $1 AND user_id = $2 RETURNING id`, [
    generationId(req),
    currentUser(req).id,
  ]);
  if (deleted.length === 0) throw new HttpError(404, NOT_FOUND);
  res.status(204).end();
});
