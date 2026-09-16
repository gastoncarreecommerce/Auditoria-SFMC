'use client';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const [des, setDes] = useState([]);
  const [loadingDes, setLoadingDes] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoContinue, setAutoContinue] = useState(false);
  const [totalDeleted, setTotalDeleted] = useState(0);
  const [done, setDone] = useState(false);
  const [log, setLog] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const stopRef = useRef(false); // para poder cortar un auto-continuar en curso

  useEffect(() => {
    fetch('/api/data-extensions')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setDes(data.dataExtensions || []);
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoadingDes(false));
  }, []);

  const selected = des.find((d) => d.customerKey === selectedKey);
  const canDelete = selected && confirmText.trim() === selected.name && !busy && !done;

  function selectDe(key) {
    setSelectedKey(key);
    setConfirmText('');
    setTotalDeleted(0);
    setDone(false);
    setLog([]);
    setErrorMsg('');
    stopRef.current = false;
  }

  async function deleteBatch() {
    if (!selected) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/delete-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerKey: selected.customerKey, confirmName: confirmText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');

      setTotalDeleted((n) => n + data.deleted);
      setLog((l) => [...l, { at: new Date().toLocaleTimeString(), deleted: data.deleted, done: data.done }].slice(-50));

      if (data.done) {
        setDone(true);
        setBusy(false);
        return;
      }

      if (autoContinue && !stopRef.current) {
        setTimeout(() => deleteBatch(), 400);
      } else {
        setBusy(false);
      }
    } catch (err) {
      setErrorMsg(err.message);
      setBusy(false);
      stopRef.current = true;
    }
  }

  function stopAuto() {
    stopRef.current = true;
    setAutoContinue(false);
  }

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>SFMC — Vaciar Data Extension</h1>
        <button onClick={logout} style={linkBtn}>
          Salir
        </button>
      </div>

      <p style={{ color: '#999', fontSize: 14, lineHeight: 1.5 }}>
        Elegí una DE, escribí su nombre exacto para confirmar, y borrá de a tandas de hasta 500 filas. Esto borra las
        filas de adentro de la DE — la DE en sí sigue existiendo, vacía.
      </p>

      {loadingDes && <p>Cargando Data Extensions...</p>}
      {loadError && <p style={{ color: '#ff6b6b' }}>Error cargando DEs: {loadError}</p>}

      {!loadingDes && !loadError && (
        <>
          <select
            value={selectedKey}
            onChange={(e) => selectDe(e.target.value)}
            style={selectStyle}
          >
            <option value="">— Elegí una Data Extension —</option>
            {des.map((d) => (
              <option key={d.customerKey} value={d.customerKey}>
                {d.name}
              </option>
            ))}
          </select>

          {selected && (
            <div style={{ marginTop: 20, padding: 20, background: '#1a1d24', borderRadius: 12 }}>
              <p style={{ margin: 0, fontSize: 14 }}>
                Vas a vaciar: <strong>{selected.name}</strong>
              </p>
              <p style={{ color: '#ffb020', fontSize: 13 }}>
                ⚠️ Esto es irreversible. Escribí el nombre exacto de la DE para habilitar el borrado.
              </p>
              <input
                type="text"
                placeholder="Nombre exacto de la DE"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={busy || done}
                style={inputStyle}
              />

              <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
                <button onClick={deleteBatch} disabled={!canDelete} style={dangerBtn(canDelete)}>
                  {busy ? 'Borrando...' : 'Borrar siguiente tanda (≤500)'}
                </button>
                <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={autoContinue}
                    onChange={(e) => setAutoContinue(e.target.checked)}
                    disabled={busy || done}
                  />
                  seguir automáticamente
                </label>
                {busy && autoContinue && (
                  <button onClick={stopAuto} style={linkBtn}>
                    Frenar
                  </button>
                )}
              </div>

              {errorMsg && <p style={{ color: '#ff6b6b', marginTop: 12 }}>Error: {errorMsg}</p>}
              {done && <p style={{ color: '#4ade80', marginTop: 12 }}>✓ Listo — la DE quedó sin filas.</p>}

              <p style={{ marginTop: 16, fontSize: 14 }}>
                Total borrado en esta sesión: <strong>{totalDeleted.toLocaleString('es-AR')}</strong>
              </p>

              {log.length > 0 && (
                <div style={{ marginTop: 12, maxHeight: 200, overflowY: 'auto', fontSize: 12, color: '#999' }}>
                  {log
                    .slice()
                    .reverse()
                    .map((l, i) => (
                      <div key={i}>
                        {l.at} — {l.deleted} borradas {l.done ? '(DE vacía)' : ''}
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const selectStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #333',
  background: '#1a1d24',
  color: '#e6e6e6',
  marginTop: 16,
  boxSizing: 'border-box',
};

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #333',
  background: '#0f1115',
  color: '#e6e6e6',
  marginTop: 8,
  boxSizing: 'border-box',
};

const linkBtn = {
  background: 'none',
  border: 'none',
  color: '#999',
  cursor: 'pointer',
  fontSize: 13,
  textDecoration: 'underline',
};

function dangerBtn(enabled) {
  return {
    padding: '10px 16px',
    borderRadius: 8,
    border: 'none',
    background: enabled ? '#dc2626' : '#3a3a3a',
    color: enabled ? 'white' : '#777',
    fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}
