// Card reaches this through `React.lazy`, so nothing in the static import graph
// connects the two. A fingerprint that traced only static edges would call a
// Card story unchanged after this file moved, and skip photographing it.
export function Footnote({ children }) {
  return <small style={{ color: '#718096', fontSize: 12 }}>{children}</small>;
}
