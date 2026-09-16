'use client';
import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      window.location.href = '/';
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Error al iniciar sesión');
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={handleSubmit} style={{ width: 320, padding: 32, background: '#1a1d24', borderRadius: 12 }}>
        <h1 style={{ fontSize: 18, marginTop: 0 }}>SFMC — Vaciar DEs</h1>
        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid #333',
            background: '#0f1115',
            color: '#e6e6e6',
            boxSizing: 'border-box',
            marginBottom: 12,
          }}
        />
        {error && <p style={{ color: '#ff6b6b', fontSize: 13 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: 'none',
            background: '#3b82f6',
            color: 'white',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
