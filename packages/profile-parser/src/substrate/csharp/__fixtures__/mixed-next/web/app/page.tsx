const API_BASE = 'https://backend.example.test';
export async function HomePage() {
  return fetch('/api/v1/items');
}
export async function ReadConfigured() {
  return fetch(`${API_BASE}/api/v1/items`);
}
export async function WrongMethod() {
  return fetch('/api/v1/items', { method: 'POST' });
}
export async function MissingRoute() {
  return fetch('/api/does-not-exist');
}
export default HomePage;
