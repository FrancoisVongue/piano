// No-op analytics facade.
//
// Piano ships without an analytics provider out of the box — self-hosted
// deployments shouldn't be phoning home to a third party by default. The
// `Analytics` object below keeps the same surface as the original PostHog
// facade so call sites (Analytics.track / identify / reset / init) stay
// untouched. Wire in your own provider here if you need one.

type AnalyticsUser = { id: string; email?: string; name?: string | null }

export const Analytics = {
  init() {},
  track(_eventName: string, _properties?: Record<string, unknown>) {},
  identify(_user: AnalyticsUser) {},
  reset() {},
}
