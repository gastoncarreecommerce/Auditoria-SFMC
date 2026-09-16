'use client';
import { useRef, useState, useEffect } from 'react';

const SUBMIT_CHUNK = 500;

export default function Home() {
  const [des, setDes] = useState([]);
  const [loadingDes, setLoadingDes] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const [scanning, setScanning] = useState(false);
  const [page, setPage] = useState(1);
  const [scanDone, setScanDone] = useState(false);
  const [subscriberKeys, setSubscriberKeys] = useState([]);
  const [unresolvedCount, setUnresolvedCount] = useState(0);
  const [scanLog, setScanLog] = useState([]);
  const [scanError, setScanError] = useState('');
  const stopRef = useRef(false);

  const [submitting, setSubmitting] = useState(false);
  const [operations, setOperations] = useState([]); // {id, submitted, status, checking}

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
  const canScan = selected && confirmText.trim() === selected.name && !scanning;

  function selectDe(key) {
    setSelectedKey(key);
    setConfirmText('');
    resetScan();
  }

  function resetScan() {
    setPage(1);
    setScanDone(false);
    setSubscriberKeys([]);
    setUnresolvedCount(0);
    setScanLog([]);
    setScanError('');
    setOperations([]);
    stopRef.current = false;
  }

  async function scanNextPage(currentPage) {
    if (!selected) return;
    setScanning(true);
    setScanError('');
    try {
      const res = await fetch('/api/scan-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerKey: selected.customerKey, confirmName: confirmText.trim(), page: currentPage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');

      setSubscriberKeys((prev) => prev.concat(data.subscriberKeys));
      setUnresolvedCount((n) => n + data.unresolved);
      setScanLog((l) =>
        [
          ...l,
          {
            at: new Date().toLocaleTimeString(),
            page: currentPage,
            resolved: data.subscriberKeys.length,
            unresolved: data.unresolved,
          },
        ].slice(-100)
      );

      if (!data.hasMore) {
        setScanDone(true);
        setScanning(false);
        return;
      }

      const nextPage = currentPage + 1;
      setPage(nextPage);
      if (!stopRef.current) {
        setTimeout(() => scanNextPage(nextPage), 200);
      } else {
        setScanning(false);
      }
    } catch (err) {
      setScanError(err.message);
      setScanning(false);
      stopRef.current = true;
    }
  }

  function startScan() {
    resetScan();
    stopRef.current = false;
    setTimeout(() => scanNextPage(1), 0);
  }

  function stopScan() {
    stopRef.current = true;
  }

  async function submitAll() {
    setSubmitting(true);
    const chunks = [];
    for (let i = 0; i < subscriberKeys.length; i += SUBMIT_CHUNK) {
      chunks.push(subscriberKeys.slice(i, i + SUBMIT_CHUNK));
    }
    const newOps = [];
    for (const chunk of chunks) {
      try {
        const res = await fetch('/api/submit-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriberKeys: chunk }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error desconocido');
        newOps.push({ id: data.operationId, submitted: data.submitted, status: null, error: null });
      } catch (err) {
        newOps.push({ id: null, submitted: chunk.length, status: null, error: err.message });
      }
      setOperations((prev) => [...prev, newOps[newOps.length - 1]]);
    }
    setSubmitting(false);
  }

  async function checkStatus(opId) {
    setOperations((prev) => prev.map((o) => (o.id === opId ? { ...o, checking: true } : o)));
    try {
      const res = await fetch('/api/delete-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: opId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setOperations((prev) =>
        prev.map((o) => (o.id === opId ? { ...o, status: data.status, checking: false } : o))
      );
    } catch (err) {
      setOperations((prev) => prev.map((o) => (o.id === opId ? { ...o, error: err.message, checking: false } : o)));
    }
  }

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>SFMC — Borrar contactos por Data Extension</h1>
        <button onClick={logout} style={linkBtn}>
          Salir
        </button>
      </div>

      <p style={{ color: '#999', fontSize: 14, lineHeight: 1.5 }}>
        Elegí una DE, escribí su nombre exacto para confirmar, y escaneá sus filas: por cada una se resuelve el
        SubscriberKey real del contacto en SFMC. Al final mandás UNA solicitud de borrado global — borra al{' '}
        <strong>contacto entero</strong> (todas las BUs, todas las DEs, historial de envíos), no solo esta DE. SFMC la
        procesa en cola y puede tardar horas; podés consultar el estado con el OperationID.
      </p>

      {loadingDes && <p>Cargando Data Extensions...</p>}
      {loadError && <p style={{ color: '#ff6b6b' }}>Error cargando DEs: {loadError}</p>}

      {!loadingDes && !loadError && (
        <>
          <select value={selectedKey} onChange={(e) => selectDe(e.target.value)} style={selectStyle}>
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
                DE elegida: <strong>{selected.name}</strong>
              </p>
              <p style={{ color: '#ffb020', fontSize: 13 }}>
                ⚠️ Esto borra contactos de SFMC de forma global e irreversible. Escribí el nombre exacto de la DE para
                habilitar el escaneo.
              </p>
              <input
                type="text"
                placeholder="Nombre exacto de la DE"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={scanning}
                style={inputStyle}
              />

              <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
                <button onClick={startScan} disabled={!canScan} style={dangerBtn(canScan)}>
                  {scanning ? `Escaneando página ${page}...` : 'Escanear DE'}
                </button>
                {scanning && (
                  <button onClick={stopScan} style={linkBtn}>
                    Frenar
                  </button>
                )}
              </div>

              {scanError && <p style={{ color: '#ff6b6b', marginTop: 12 }}>Error: {scanError}</p>}

              {(subscriberKeys.length > 0 || unresolvedCount > 0) && (
                <p style={{ marginTop: 16, fontSize: 14 }}>
                  Resueltos: <strong>{subscriberKeys.length.toLocaleString('es-AR')}</strong> contactos
                  {unresolvedCount > 0 && (
                    <>
                      {' '}
                      — sin resolver: <strong style={{ color: '#ffb020' }}>{unresolvedCount.toLocaleString('es-AR')}</strong>
                    </>
                  )}
                  {scanDone && <span style={{ color: '#4ade80' }}> — escaneo completo</span>}
                </p>
              )}

              {scanLog.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 160, overflowY: 'auto', fontSize: 12, color: '#999' }}>
                  {scanLog
                    .slice()
                    .reverse()
                    .map((l, i) => (
                      <div key={i}>
                        {l.at} — página {l.page}: {l.resolved} resueltos, {l.unresolved} sin resolver
                      </div>
                    ))}
                </div>
              )}

              {scanDone && subscriberKeys.length > 0 && (
                <div style={{ marginTop: 20, borderTop: '1px solid #333', paddingTop: 16 }}>
                  <p style={{ fontSize: 13, color: '#ffb020' }}>
                    Vas a mandar el borrado global de {subscriberKeys.length.toLocaleString('es-AR')} contactos, en{' '}
                    {Math.ceil(subscriberKeys.length / SUBMIT_CHUNK)} solicitud(es) de hasta {SUBMIT_CHUNK} cada una.
                  </p>
                  <button
                    onClick={submitAll}
                    disabled={submitting || operations.length > 0}
                    style={dangerBtn(!submitting && operations.length === 0)}
                  >
                    {submitting ? 'Enviando...' : 'Enviar solicitud de borrado global'}
                  </button>
                </div>
              )}

              {operations.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <p style={{ fontSize: 13, color: '#999' }}>Solicitudes enviadas:</p>
                  {operations.map((op, i) => (
                    <div key={i} style={{ fontSize: 12, marginBottom: 8, padding: 8, background: '#0f1115', borderRadius: 6 }}>
                      {op.error ? (
                        <span style={{ color: '#ff6b6b' }}>
                          Tanda de {op.submitted}: error — {op.error}
                        </span>
                      ) : (
                        <>
                          OperationID <strong>{op.id}</strong> ({op.submitted} contactos){' '}
                          <button onClick={() => checkStatus(op.id)} style={linkBtn} disabled={op.checking}>
                            {op.checking ? 'consultando...' : 'consultar estado'}
                          </button>
                          {op.status && (
                            <pre style={{ whiteSpace: 'pre-wrap', color: '#999', marginTop: 4 }}>
                              {JSON.stringify(op.status, null, 2)}
                            </pre>
                          )}
                        </>
                      )}
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
