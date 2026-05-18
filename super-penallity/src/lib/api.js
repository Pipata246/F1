// Тонкая обёртка над fetch к /api/user. Все клиентские вызовы серверного action-router'а
// идут через POST с JSON-телом — этот helper стандартизирует формат и парсит ответ.
export async function apiPost(payload) {
  const res = await fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  return res.json();
}
