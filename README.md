# Shift Handover · EOS Bench Audit — standalone app

> Rexville Solutions copy (black/amber theme, Rexville logo). Shares the same live Supabase data as the Fiege board.

This is the same board as the artifact, rebuilt as a small standalone web app
so it lives at its own permanent link instead of inside a Claude
conversation — built the same way as your Picking & Packing Audits Board:
one static HTML file, Supabase as the shared database, Netlify to host it.
No build step, no server to maintain.

## What's in this folder

- `index.html` — the whole app (structure + styling). **Already wired up
  to a live Supabase database — see below.**
- `app.js` — the whole app's logic (loaded by index.html).
- `supabase-schema.sql` — the schema that was run to create the database
  tables, security rules, and photo storage bucket. Kept here for
  reference; you don't need to run it again.
- `README.md` — this file.

## Database: already done

A new Supabase project, **shift-handover-eos-bench-audit**, was created for
this app (separate from your Picking & Packing board's project, so the two
never share or collide on data) and `supabase-schema.sql` has already been
run against it — the three tables, security rules, and the public `photos`
storage bucket all exist. `index.html` already has that project's URL and
anon key filled in, so the file you have is ready to deploy as-is. Nothing
to do here unless you want to inspect it yourself at
[supabase.com/dashboard](https://supabase.com/dashboard/project/latnpojayzonvjyrwsgv).

## Deploying: GitHub Pages (current recommendation)

This app was originally deployed to Netlify, but Netlify's free plan now
runs on a monthly credit allowance that can block new deploys once it's
used up. See `../GITHUB-PAGES-DEPLOY.md` for simple step-by-step
instructions to host this on GitHub Pages instead — free, no credit limit,
and just as easy as Netlify's drag-and-drop was.

## Alternative: Netlify

If you'd still rather use Netlify (e.g. once your credits reset, or on a
paid plan):

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag this whole folder (or just `index.html`, `app.js`, and
   `supabase-schema.sql` together) onto the page.
3. Netlify gives you a live URL immediately, e.g.
   `something-random.netlify.app`. That's the link to share with your team.

To update the site later (say, after editing `index.html`), drag the folder
onto the same Netlify site again from your team's Netlify dashboard, or use
Netlify's CLI/GitHub integration if you'd rather connect a repo — either
works, since this is just static files.

## How it works day to day

- **Board / Summary** toggle at the top switches between filling in today's
  handover/audit and browsing what's been logged.
- **Date / Shift / Area / Department** filters narrow the view. Only today
  and tomorrow can have new entries logged against them; any earlier date
  is locked behind the shared passcode (`1254`) so people can look back
  without accidentally editing history.
- The app's "today" rolls over at **6:00am**, not midnight — so a night
  shift working at, say, 2am is still logging against yesterday's date,
  and the site only flips over to the new day once it's 6am. This uses
  whatever local time each device's browser reports, so it just works
  without any timezone setup.
- Each **Save handover** / **Save audit & start new** click writes one row
  to the database and clears the form for the next entry — it does not
  autosave every keystroke, so nothing is shared with the team until you
  press Save. (This is a deliberate difference from the original artifact,
  which auto-saved as you typed — that only worked because the whole page
  republished itself. Here, matching the Picking & Packing board's model,
  the explicit Save button is what "hands off" an entry.)
- **Edit checklist topics** and **Clear all summary data** are both gated
  behind the same shared passcode (`1254`). This passcode lives in the
  page's own code, not the database, so treat it as a light deterrent for
  your team, not real security — anyone with access to the site's files
  could read it. If that's ever a concern, the fix is adding real user
  accounts via Supabase Auth.
- Photos (on the bench audit's "Is the pack bench clean?" question) are
  compressed in the browser and uploaded to the `photos` storage bucket,
  then shown from their public URL — the database itself just stores the
  link, not the image.
- Everyone looking at the site sees updates live (via Supabase Realtime) —
  no need to refresh after a teammate saves an entry.

## Staying fast as history piles up

The app never downloads the entire history table. On load it only fetches a
rolling 14-day window (today, tomorrow, and the last two weeks), and that's
the only query that runs automatically — including every time it re-syncs
after a live update from a teammate. Picking an older date from the calendar
fetches just that one date on demand. So whether the database has a month of
entries or five years of them, opening the site and browsing recent shifts
costs the same either way — the only thing that gets slower with a huge
amount of history is deliberately looking something up from a long time ago,
which is inherently a one-off, occasional lookup anyway.
