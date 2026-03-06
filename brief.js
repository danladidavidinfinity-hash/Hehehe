// Netlify function: generates AI trade brief via Anthropic
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || ''
  if (!apiKey) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) }
  }

  let body
  try { body = JSON.parse(event.body) } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: body.messages || [],
      })
    })

    const data = await res.json()
    if (data.error) return { statusCode: 200, headers, body: JSON.stringify({ error: data.error.message }) }

    const text = data.content?.map(b => b.text || '').join('') || ''
    return { statusCode: 200, headers, body: JSON.stringify({ text }) }
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) }
  }
}
