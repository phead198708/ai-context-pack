export const colors = {
  background: '#0B1020',
  surface: '#18213A',
  accent: '#3B82F6',
  text: '#F8FAFC',
  muted: '#AAB7CE',
} as const;
export const spacing = { sm: 8, md: 16, lg: 24 } as const;
export const typography = {
  title: { fontSize: 28, fontWeight: '700' as const },
  heading: { fontSize: 20, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24 },
  label: { fontSize: 15, fontWeight: '600' as const },
} as const;
