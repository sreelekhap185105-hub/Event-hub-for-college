// server.js
// Simple Express proxy: Eventbrite + Google public calendar + ICS fetch
const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const ical = require('node-ical');   // npm i node-ical
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EVENTBRITE_TOKEN = process.env.EVENTBRITE_TOKEN || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || ''; // optional if using Calendar API

function normalizeEvent({ id, title, description, start, end, venue, organizerName, organizerType, sourceName, external=true }) {
  return {
    id: id,
    title: title || '',
    description: description || '',
    start: start || '',
    end: end || '',
    venue: venue || '',
    organizer: { name: organizerName || sourceName || 'Unknown', type: organizerType || 'other', verified: organizerType === 'government' || organizerType === 'company' },
    source: { name: sourceName || 'external' },
    tags: [],
    external: external,
    registration: { open: true }
  };
}

/* ---------- Eventbrite endpoint ---------- */
app.get('/api/eventbrite', async (req, res) => {
  if (!EVENTBRITE_TOKEN) return res.status(500).json({ error: 'Missing EVENTBRITE_TOKEN env var' });
  const q = req.query.q || '';
  const page = req.query.page || 1;
  const url = `https://www.eventbriteapi.com/v3/events/search/?q=${encodeURIComponent(q)}&expand=venue,organizer&page=${page}`;

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${EVENTBRITE_TOKEN}` }});
    const json = await r.json();
    const events = (json.events || []).map(ev => {
      return normalizeEvent({
        id: `eventbrite_${ev.id}`,
        title: ev.name?.text,
        description: ev.description?.text,
        start: ev.start?.utc || ev.start?.local,
        end: ev.end?.utc || ev.end?.local,
        venue: ev.venue?.address?.localized_address_display || ev.venue?.name,
        organizerName: ev.organizer?.name,
        organizerType: 'company',
        sourceName: 'Eventbrite',
        external: true
      });
    });
    res.json({ events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Eventbrite fetch failed', details: err.message });
  }
});

/* ---------- Google Calendar public calendar (no OAuth) ---------- */
/* If the calendar is public, you can use the Google calendar "events" API with API key:
   GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?key=API_KEY
*/
app.get('/api/google-calendar', async (req, res) => {
  const calendarId = req.query.calendarId;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Missing GOOGLE_API_KEY env var' });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?key=${GOOGLE_API_KEY}&singleEvents=true&orderBy=startTime`;
  try {
    const r = await fetch(url);
    const json = await r.json();
    const events = (json.items || []).map(it => normalizeEvent({
      id: `gcal_${it.id}`,
      title: it.summary,
      description: it.description || '',
      start: (it.start && (it.start.dateTime || it.start.date)),
      end: (it.end && (it.end.dateTime || it.end.date)),
      venue: it.location || '',
      organizerName: (it.organizer && it.organizer.displayName) || it.organizer?.email || 'Google Calendar',
      organizerType: 'other',
      sourceName: 'Google Calendar',
      external: true
    }));
    res.json({ events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Google Calendar fetch failed', details: err.message });
  }
});

/* ---------- Fetch and parse ICS ---------- */
app.get('/api/fetch-ics', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  try {
    const parsed = await ical.async.fromURL(url); // node-ical helper
    const events = [];
    for (const k of Object.keys(parsed)) {
      const ev = parsed[k];
      if (ev && ev.type === 'VEVENT') {
        events.push(normalizeEvent({
          id: `ics_${(ev.uid || ev.summary || '').toString().slice(0,40)}`,
          title: ev.summary || '',
          description: ev.description || '',
          start: ev.start ? ev.start.toISOString() : '',
          end: ev.end ? ev.end.toISOString() : '',
          venue: ev.location || '',
          organizerName: ev.organizer || '',
          organizerType: 'other',
          sourceName: 'ICS',
          external: true
        }));
      }
    }
    res.json({ events });
  } catch (err) {
    console.error('ICS fetch/parse error', err);
    res.status(500).json({ error: 'Failed to fetch/parse ICS', details: err.message });
  }
});

/* ---------- Simple health ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, ()=> console.log('Proxy running on', PORT));
