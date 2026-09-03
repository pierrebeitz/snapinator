import { Badge } from './Badge';
import { Button } from './Button';

export function Card({ title, body, tone }) {
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        padding: 20,
        maxWidth: 360,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 16 }}>{title}</strong>
        {tone && <Badge tone={tone}>{tone}</Badge>}
      </div>
      <p style={{ margin: '0 0 16px', color: '#4a5568', lineHeight: 1.5 }}>{body}</p>
      <Button>Open</Button>
    </div>
  );
}
