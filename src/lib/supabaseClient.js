const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfig = {
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  isConfigured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
};

async function request(path, options = {}) {
  if (!supabaseConfig.isConfigured) {
    throw new Error('Supabase no esta configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.');
  }

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Error Supabase ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export const agxApi = {
  list(table, query = 'select=*') {
    return request(`/rest/v1/${table}?${query}`);
  },
  insert(table, payload) {
    return request(`/rest/v1/${table}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  update(table, id, payload) {
    return request(`/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
};
