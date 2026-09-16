export const metadata = {
  title: 'SFMC — Vaciar Data Extensions',
  description: 'Herramienta interna para vaciar Data Extensions de SFMC de a tandas.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0f1115', color: '#e6e6e6' }}>
        {children}
      </body>
    </html>
  );
}
