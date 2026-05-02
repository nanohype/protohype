# React Changelog

## 19.0.0 - 2026-01-15

### Breaking Changes

- **Removed `ReactDOM.render`** — Use `createRoot` from `react-dom/client`. The legacy render path is deleted. See the migration guide.
- **Removed `ReactDOM.hydrate`** — Use `hydrateRoot` from `react-dom/client`.
- **Removed `unmountComponentAtNode`** — Use `root.unmount()` returned from `createRoot`.
- **Removed `findDOMNode`** — Use refs. Was deprecated in 16.6.
- **Removed defaultProps on function components** — Use destructuring defaults in parameters instead. Class component `defaultProps` still works.
- **Removed string refs** — e.g. `<Thing ref="name" />`. Use callback refs or `createRef`. String refs were deprecated in 16.3.

### Behavior changes

- `useId` now produces different ids on SSR vs. client for compatibility with future features. If you serialize id values, migrate to stable ids from your data layer.

### Deprecations

- `UNSAFE_componentWillMount`, `UNSAFE_componentWillReceiveProps`, `UNSAFE_componentWillUpdate` now emit `console.error` (previously `console.warn`). Will be removed in 20.

## 18.3.0 - 2025-10-02

Patch release. No breaking changes.
