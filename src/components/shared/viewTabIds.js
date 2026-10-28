// The ids a full ViewTabs strip gives its tabs and the panel they control, for
// the page that labels its body with them (`aria-labelledby` the open tab).
// Kept apart from ViewTabs.jsx, which exports only the component.

/** The id of one tab. */
export const viewTabId = (idPrefix, id) => `${idPrefix}-${id}`

/** The id of the panel a full strip controls. */
export const viewTabPanelId = idPrefix => `${idPrefix}-panel`
