const styles = {
  base: {
    font: 'inherit',
    fontWeight: 600,
    padding: '8px 16px',
    borderRadius: 6,
    border: '1px solid transparent',
    cursor: 'pointer',
  },
  primary: { background: '#2b6cb0', color: '#fff' },
  secondary: { background: '#fff', color: '#2d3748', borderColor: '#cbd5e0' },
  danger: { background: '#c53030', color: '#fff' },
};

export function Button({ variant = 'primary', children }) {
  return <button style={{ ...styles.base, ...styles[variant] }}>{children}</button>;
}
