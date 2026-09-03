const tones = {
  neutral: { background: '#edf2f7', color: '#4a5568' },
  success: { background: '#c6f6d5', color: '#22543d' },
  warning: { background: '#feebc8', color: '#7b341e' },
};

export function Badge({ tone = 'neutral', children }) {
  return (
    <span
      style={{
        ...tones[tone],
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}
