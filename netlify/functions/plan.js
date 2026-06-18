const fetch = require('node-fetch');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const MODEL = 'llama-3.1-8b-instant'; // 100k TPM free tier — avoids 413 errors

/* ─── WEATHER ─────────────────────────────────────────────── */

function weatherWindow(s, e) {
  const today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(s), end = new Date(e);
  if (isNaN(start) || isNaN(end)) return null;
  const maxAhead = new Date(today); maxAhead.setDate(today.getDate() + 15);
  if (end < today)   return { ok: false, reason: 'past' };
  if (start > maxAhead) return { ok: false, reason: 'too_far' };
  const cs = start < today ? today : start;
  const ce = end > maxAhead ? maxAhead : end;
  const fmt = d => d.toISOString().slice(0,10);
  return { ok: true, start: fmt(cs), end: fmt(ce) };
}

function wDesc(c) {
  if (c===0) return 'Clear sky';
  if (c<=3)  return 'Partly cloudy';
  if (c<=48) return 'Fog';
  if (c<=67) return 'Rain';
  if (c<=77) return 'Snow';
  if (c<=82) return 'Showers';
  return 'Storm';
}
const isGood = c => c <= 3;

async function getWeather(destination, startDate, endDate) {
  const win = weatherWindow(startDate, endDate);
  if (!win || !win.ok) return { ok: false, reason: win ? win.reason : 'bad_dates' };

  try {
    const city = destination.split(',')[0].trim();
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
    ).then(r => r.json());
    if (!geo.results?.length) return { ok: false, reason: 'no_location' };

    const { latitude, longitude, name, country } = geo.results[0];
    const w = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
      `&timezone=auto&start_date=${win.start}&end_date=${win.end}`
    ).then(r => r.json());

    if (!w.daily?.time) return { ok: false, reason: 'no_data' };

    const days = w.daily.time.map((date, i) => ({
      date,
      hi: Math.round(w.daily.temperature_2m_max[i]),
      lo: Math.round(w.daily.temperature_2m_min[i]),
      rain: w.daily.precipitation_sum[i],
      code: w.daily.weathercode[i],
      desc: wDesc(w.daily.weathercode[i]),
      good: isGood(w.daily.weathercode[i])
    }));

    const goodDays = days.filter(d => d.good).map(d => d.date);
    const badDays  = days.filter(d => !d.good).map(d => d.date);

    let summary = `Live weather for ${name}, ${country}:\n`;
    days.forEach(d => {
      summary += `- ${d.date}: ${d.desc}, ${d.lo}–${d.hi}°C${d.rain > 1 ? `, ${d.rain}mm rain` : ''}\n`;
    });
    summary += `\nGOOD days (outdoor activities): ${goodDays.join(', ') || 'none'}\n`;
    summary += `RAINY days (indoor activities): ${badDays.join(', ') || 'none'}\n`;

    return {
      ok: true,
      location: `${name}, ${country}`,
      summary,
      board: days   // sent to frontend for the departure board UI
    };
  } catch(e) {
    console.error('Weather error:', e.message);
    return { ok: false, reason: 'error' };
  }
}

/* ─── TAVILY SEARCH ───────────────────────────────────────── */

async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return { error: 'TAVILY_API_KEY not set' };
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 3
      })
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('Tavily error:', r.status, err);
      return { error: `Tavily error ${r.status}` };
    }
    const data = await r.json();
    // Truncate results to keep token count low in agentic loops
    const results = (data.results || []).slice(0, 3).map(x =>
      `**${x.title}**\n${(x.content || '').slice(0, 250)}\nURL: ${x.url}`
    ).join('\n\n');
    return { answer: (data.answer || '').slice(0, 300), results, raw: data.results || [] };
  } catch(e) {
    console.error('Tavily fetch error:', e.message);
    return { error: e.message };
  }
}

/* ─── BOOKING LINKS ───────────────────────────────────────── */

function buildLinks(t) {
  if (!t.destination) return null;
  const dest = encodeURIComponent(t.destination);
  const adults = t.groupSize || 2;
  return {
    booking: `https://www.booking.com/searchresults.html?ss=${dest}&checkin=${t.arrivalDate||''}&checkout=${t.departureDate||''}&group_adults=${adults}`,
    airbnb:  `https://www.airbnb.com/s/${dest}/homes?checkin=${t.arrivalDate||''}&checkout=${t.departureDate||''}&adults=${adults}`,
    cars:    `https://www.rentalcars.com/SearchResults.do?country=${dest}&depdate=${t.arrivalDate||''}&retdate=${t.departureDate||''}&pax=${adults}`,
    maps:    `https://www.google.com/maps/search/things+to+do+in+${dest}`
  };
}

/* ─── GROQ AGENTIC LOOP ───────────────────────────────────── */

// Tool definition for Groq function calling
const TOOLS = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the live web for current travel info: attractions, restaurants, opening hours, prices, events, local tips. Use this whenever you need real, up-to-date information about a destination.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Specific search query, e.g. "best restaurants Tokyo Shinjuku 2025" or "top things to do Lisbon families"'
        }
      },
      required: ['query']
    }
  }
}];

async function runAgentLoop(messages, systemPrompt) {
  let allMessages = [...messages];
  let searchesUsed = 0;
  const MAX_SEARCHES = 2; // keep tokens low on free tier // stay within free tier comfortably

  for (let turn = 0; turn < 6; turn++) {
    const body = {
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.6,
      tools: TOOLS,
      tool_choice: 'auto',
      messages: [{ role: 'system', content: systemPrompt }, ...allMessages]
    };

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Groq API error ${r.status}: ${err.slice(0, 300)}`);
    }

    const data = await r.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No response from Groq');

    const msg = choice.message;
    allMessages.push(msg);

    // No tool calls → final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0 || choice.finish_reason === 'stop') {
      return { text: msg.content || '', searchesUsed };
    }

    // Handle tool calls
    for (const call of msg.tool_calls) {
      if (call.function.name === 'web_search' && searchesUsed < MAX_SEARCHES) {
        const { query } = JSON.parse(call.function.arguments || '{}');
        console.log(`[PlanAway] searching: "${query}"`);
        const result = await tavilySearch(query);
        searchesUsed++;

        const toolResult = result.error
          ? `Search failed: ${result.error}`
          : `${result.answer ? 'Summary: ' + result.answer + '\n\n' : ''}${result.results}`;

        allMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult
        });
      } else {
        // Limit reached or unknown tool
        allMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'Search limit reached. Use your existing knowledge for this part.'
        });
      }
    }
  }

  // Fallback: extract last text content
  const last = [...allMessages].reverse().find(m => m.role === 'assistant' && m.content);
  return { text: last?.content || 'Something went wrong, please try again.', searchesUsed };
}

/* ─── NETLIFY HANDLER ─────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!GROQ_API_KEY)   return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not set on server.' }) };
  if (!TAVILY_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'TAVILY_API_KEY not set on server.' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tripData = {}, conversationHistory = [] } = body;
  if (!conversationHistory.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No messages provided' }) };
  }

  try {
    // Fetch weather in parallel (non-blocking)
    let weather = { ok: false };
    if (tripData.destination && tripData.arrivalDate && tripData.departureDate) {
      weather = await getWeather(tripData.destination, tripData.arrivalDate, tripData.departureDate);
    }

    const links = buildLinks(tripData);

    let weatherCtx = '';
    if (weather.ok) {
      weatherCtx = weather.summary;
    } else if (weather.reason === 'too_far') {
      weatherCtx = `Trip is more than 16 days away — no live forecast yet. Describe typical seasonal weather for ${tripData.destination} during those dates instead. Tell the user you will update the weather plan closer to departure.`;
    } else if (weather.reason === 'past') {
      weatherCtx = 'Those dates are in the past.';
    }

    const systemPrompt = `You are PlanAway — an autonomous AI travel planning agent. You build complete, highly personalized, day-by-day trip itineraries.

YOUR PROCESS:
1. If you are missing key facts, ask 1–3 specific questions (never a long list). Key facts: destination, exact dates, who is travelling (adults / kids + ages), interests & pace, budget level, visited before?, transport preference, accommodation type.
2. Once you have enough, BUILD the full itinerary. Do not keep asking — plan.
3. Use the web_search tool to find REAL, CURRENT places: specific named attractions, restaurants, opening hours, entry prices, events during their travel dates. Search 2–4 times for a quality plan.
4. Schedule around weather: outdoor activities on GOOD days, indoor (museums, galleries, aquariums, markets, cooking classes) on RAINY days. Say WHY each day is arranged the way it is.
5. For families with children, label activities kids will love AND include something for adults each day.
6. If they have visited before, focus on NEW experiences.
7. End with concrete next steps and booking links.

LIVE WEATHER DATA:
${weatherCtx || 'Not available yet — need destination + both dates.'}

BOOKING LINKS (embed as markdown links in the plan):
${links ? `- Hotels → ${links.booking}\n- Airbnb → ${links.airbnb}\n- Car rental → ${links.cars}\n- Map → ${links.maps}` : 'Not available yet.'}

TRIP CONTEXT:
${JSON.stringify(tripData, null, 2)}

STYLE:
- Warm, specific, never generic. Write like a sharp local friend, not a travel brochure.
- Use markdown: ## Day 1 headers, **Bold place names**, - lists, [text](url) links.
- Always include: time of day suggestions, rough costs, travel time between stops.
- Reply in the SAME language the user writes in (Bulgarian, English, German, etc.).`;

    const { text, searchesUsed } = await runAgentLoop(conversationHistory, systemPrompt);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        searchesUsed,
        weather: weather.ok ? { location: weather.location, board: weather.board } : null,
        links,
        ok: true
      })
    };

  } catch(err) {
    console.error('Handler error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'server_error', message: err.message })
    };
  }
};
