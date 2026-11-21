import type { PanelMessage } from "./lib/types.ts";

// The toolbar click is handled here (instead of openPanelOnActionClick) so the click also
// grants activeTab for the current page and the open panel can be told to re-extract.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // sidePanel.open() must run synchronously inside the user gesture; do not await before it.
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const message: PanelMessage = { type: "clipper:extract", tabId: tab.id };
  void opening
    .then(() => chrome.runtime.sendMessage(message))
    // A freshly opened panel extracts on load and may not be listening yet.
    .catch(() => undefined);
});
