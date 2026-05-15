export function TmaTopSafe({ variant = 'dark', fixed = false, className = '' }) {
  const cls = [
    'tma-top-safe',
    `tma-top-safe--${variant}`,
    fixed ? 'tma-top-safe--fixed' : '',
    className,
  ].filter(Boolean).join(' ');
  return <div className={cls} aria-hidden />;
}
