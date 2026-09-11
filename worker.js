function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function getAnonymousId(request, body) {
  return (
    request.headers.get("x-anonymous-id") ||
    body?.authorId ||
    body?.voterId ||
    body?.reactorId ||
    ""
  );
}

function makeId() {
  return crypto.randomUUID();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // =========================
      // API: thread list
      // =========================
      if (request.method === "GET" && path === "/api/threads") {
        const result = await env.DB.prepare(`
          SELECT
            t.id,
            t.title,
            t.body,
            t.author_id,
            t.created_at,
            t.last_activity,
            COUNT(p.id) - 1 AS post_count,
            COALESCE(SUM(CASE WHEN v.judgment = 'smell' THEN 1 ELSE 0 END), 0) AS judge_smell,
            COALESCE(SUM(CASE WHEN v.judgment = 'gray' THEN 1 ELSE 0 END), 0) AS judge_gray,
            COALESCE(SUM(CASE WHEN v.judgment = 'not_smell' THEN 1 ELSE 0 END), 0) AS judge_not_smell,
            COALESCE(SUM(CASE WHEN v.judgment = 'unknown' THEN 1 ELSE 0 END), 0) AS judge_unknown,
            COALESCE(SUM(CASE WHEN r.kind = 'up' THEN 1 ELSE 0 END), 0) AS reaction_up,
            COALESCE(SUM(CASE WHEN r.kind = 'down' THEN 1 ELSE 0 END), 0) AS reaction_down
          FROM threads t
          LEFT JOIN posts p ON p.thread_id = t.id
          LEFT JOIN votes v ON v.thread_id = t.id
          LEFT JOIN reactions r ON r.thread_id = t.id
          GROUP BY t.id
          ORDER BY t.last_activity DESC, t.created_at DESC
        `).all();

        const threads = (result.results || []).map((row) => ({
          id: row.id,
          title: row.title,
          body: row.body,
          authorId: row.author_id,
          createdAt: row.created_at,
          lastActivity: row.last_activity || row.created_at,
          postCount: Math.max(0, Number(row.post_count || 0)),
          judge: {
            smell: Number(row.judge_smell || 0),
            gray: Number(row.judge_gray || 0),
            notSmell: Number(row.judge_not_smell || 0),
            unknown: Number(row.judge_unknown || 0),
          },
          reactions: {
            up: Number(row.reaction_up || 0),
            down: Number(row.reaction_down || 0),
          },
        }));

        return json(threads);
      }

      // =========================
      // API: single thread
      // =========================
      const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);

      if (request.method === "GET" && threadMatch) {
        const threadId = decodeURIComponent(threadMatch[1]);

        const thread = await env.DB.prepare(`
          SELECT
            id,
            title,
            body,
            author_id,
            created_at,
            last_activity
          FROM threads
          WHERE id = ?
        `).bind(threadId).first();

        if (!thread) {
          return json({ error: "Thread not found" }, 404);
        }

        const postsResult = await env.DB.prepare(`
          SELECT
            id,
            body,
            author_id,
            created_at
          FROM posts
          WHERE thread_id = ?
          ORDER BY created_at ASC
        `).bind(threadId).all();

        const votesResult = await env.DB.prepare(`
          SELECT
            judgment,
            COUNT(*) AS count
          FROM votes
          WHERE thread_id = ?
          GROUP BY judgment
        `).bind(threadId).all();

        const reactionsResult = await env.DB.prepare(`
          SELECT
            kind,
            COUNT(*) AS count
          FROM reactions
          WHERE thread_id = ?
          GROUP BY kind
        `).bind(threadId).all();

        const voterId = request.headers.get("x-anonymous-id") || "";

        let myVote = null;
        let myReaction = null;

        if (voterId) {
          const vote = await env.DB.prepare(`
            SELECT judgment
            FROM votes
            WHERE thread_id = ? AND voter_id = ?
          `).bind(threadId, voterId).first();

          if (vote) {
            myVote = vote.judgment;
          }

          const reaction = await env.DB.prepare(`
            SELECT kind
            FROM reactions
            WHERE thread_id = ? AND reactor_id = ?
          `).bind(threadId, voterId).first();

          if (reaction) {
            myReaction = reaction.kind;
          }
        }

        const judge = {
          smell: 0,
          gray: 0,
          notSmell: 0,
          unknown: 0,
        };

        for (const row of votesResult.results || []) {
          if (row.judgment === "smell") judge.smell = Number(row.count);
          if (row.judgment === "gray") judge.gray = Number(row.count);
          if (row.judgment === "not_smell") judge.notSmell = Number(row.count);
          if (row.judgment === "unknown") judge.unknown = Number(row.count);
        }

        const reactions = {
          up: 0,
          down: 0,
        };

        for (const row of reactionsResult.results || []) {
          if (row.kind === "up") reactions.up = Number(row.count);
          if (row.kind === "down") reactions.down = Number(row.count);
        }

        return json({
          id: thread.id,
          title: thread.title,
          body: thread.body,
          authorId: thread.author_id,
          createdAt: thread.created_at,
          lastActivity: thread.last_activity || thread.created_at,

          posts: (postsResult.results || []).map((p) => ({
            id: p.id,
            body: p.body,
            authorId: p.author_id,
            createdAt: p.created_at,
          })),

          judge,
          reactions,

          voters: myVote
            ? {
                [voterId]: myVote,
              }
            : {},

          reactors: myReaction
            ? {
                [voterId]: myReaction,
              }
            : {},
        });
      }

      // =========================
      // API: create thread
      // =========================
      if (request.method === "POST" && path === "/api/threads") {
        const body = await request.json();

        const title = String(body.title || "").trim();
        const threadBody = String(body.body || "").trim();
        const authorId = getAnonymousId(request, body);

        if (!title || !threadBody || !authorId) {
          return json(
            {
              error: "title, body and anonymous ID are required",
            },
            400
          );
        }

        if (title.length > 200) {
          return json({ error: "Title is too long" }, 400);
        }

        if (threadBody.length > 10000) {
          return json({ error: "Body is too long" }, 400);
        }

        const id = makeId();
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO threads
            (id, title, body, author_id, created_at, last_activity)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .bind(id, title, threadBody, authorId, now, now)
          .run();

        await env.DB.prepare(`
          INSERT INTO posts
            (id, thread_id, body, author_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(makeId(), id, threadBody, authorId, now)
          .run();

        return json(
          {
            id,
            title,
            body: threadBody,
            authorId,
            createdAt: now,
            lastActivity: now,
          },
          201
        );
      }

      // =========================
      // API: add post
      // =========================
      const postMatch = path.match(/^\/api\/threads\/([^/]+)\/posts$/);

      if (request.method === "POST" && postMatch) {
        const threadId = decodeURIComponent(postMatch[1]);
        const body = await request.json();

        const postBody = String(body.body || "").trim();
        const authorId = getAnonymousId(request, body);

        if (!postBody || !authorId) {
          return json(
            {
              error: "body and anonymous ID are required",
            },
            400
          );
        }

        const thread = await env.DB.prepare(`
          SELECT id
          FROM threads
          WHERE id = ?
        `).bind(threadId).first();

        if (!thread) {
          return json({ error: "Thread not found" }, 404);
        }

        const id = makeId();
        const now = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO posts
            (id, thread_id, body, author_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(id, threadId, postBody, authorId, now)
          .run();

        await env.DB.prepare(`
          UPDATE threads
          SET last_activity = ?
          WHERE id = ?
        `)
          .bind(now, threadId)
          .run();

        return json(
          {
            id,
            threadId,
            body: postBody,
            authorId,
            createdAt: now,
          },
          201
        );
      }

      // =========================
      // API: vote
      // =========================
      const voteMatch = path.match(/^\/api\/threads\/([^/]+)\/vote$/);

      if (request.method === "POST" && voteMatch) {
        const threadId = decodeURIComponent(voteMatch[1]);
        const body = await request.json();

        const judgment = String(body.judgment || "").trim();
        const voterId = getAnonymousId(request, body);

        const allowed = [
          "smell",
          "gray",
          "not_smell",
          "unknown",
        ];

        if (!allowed.includes(judgment) || !voterId) {
          return json({ error: "Invalid vote" }, 400);
        }

        const thread = await env.DB.prepare(`
          SELECT id
          FROM threads
          WHERE id = ?
        `).bind(threadId).first();

        if (!thread) {
          return json({ error: "Thread not found" }, 404);
        }

        await env.DB.prepare(`
          INSERT INTO votes
            (id, thread_id, voter_id, judgment, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, voter_id)
          DO UPDATE SET
            judgment = excluded.judgment,
            created_at = excluded.created_at
        `)
          .bind(
            makeId(),
            threadId,
            voterId,
            judgment,
            new Date().toISOString()
          )
          .run();

        return json({
          ok: true,
          judgment,
        });
      }

      // =========================
      // API: reaction
      // =========================
      const reactionMatch = path.match(
        /^\/api\/threads\/([^/]+)\/reaction$/
      );

      if (request.method === "POST" && reactionMatch) {
        const threadId = decodeURIComponent(reactionMatch[1]);
        const body = await request.json();

        const kind = String(body.kind || "").trim();
        const reactorId = getAnonymousId(request, body);

        const allowed = ["up", "down"];

        if (!allowed.includes(kind) || !reactorId) {
          return json({ error: "Invalid reaction" }, 400);
        }

        const thread = await env.DB.prepare(`
          SELECT id
          FROM threads
          WHERE id = ?
        `).bind(threadId).first();

        if (!thread) {
          return json({ error: "Thread not found" }, 404);
        }

        const existing = await env.DB.prepare(`
          SELECT kind
          FROM reactions
          WHERE thread_id = ? AND reactor_id = ?
        `).bind(threadId, reactorId).first();

        // 同じボタンをもう一度押したら取り消す
        if (existing && existing.kind === kind) {
          await env.DB.prepare(`
            DELETE FROM reactions
            WHERE thread_id = ? AND reactor_id = ?
          `).bind(threadId, reactorId).run();

          return json({
            ok: true,
            reaction: null,
          });
        }

        await env.DB.prepare(`
          INSERT INTO reactions
            (id, thread_id, reactor_id, kind, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, reactor_id)
          DO UPDATE SET
            kind = excluded.kind,
            created_at = excluded.created_at
        `)
          .bind(
            makeId(),
            threadId,
            reactorId,
            kind,
            new Date().toISOString()
          )
          .run();

        return json({
          ok: true,
          reaction: kind,
        });
      }

      // =========================
      // Static files
      // =========================
      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(error);

      return json(
        {
          error: "Internal server error",
          message: error?.message || String(error),
        },
        500
      );
    }
  },
};
