import PinokioOverlay from './PinokioOverlay';
import { createLogger } from '../core/logger';
import { readTabState, writeTabState } from '../core/tabState';

const log = createLogger('Main');

let overlayInstance: PinokioOverlay | null = null;

function activateOverlay() {
  if (!overlayInstance) {
    log.info('Activating Pinokio Overlay...');
    overlayInstance = new PinokioOverlay();
  }
}

let userToggled = false;
void readTabState().then(state => {
  if (userToggled) return;
  if (state.pendingId) sessionStorage.setItem('pinokio_scroll_to', state.pendingId);
  if (state.active || sessionStorage.getItem('pinokio_overlay_active')) activateOverlay();
});

window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  // A back/forward-cache document may contain an instance from before the
  // user disabled the extension on another route in this tab.
  void readTabState().then(state => {
    if (state.active) activateOverlay();
    else if (overlayInstance) { overlayInstance.destroy(); overlayInstance = null; }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  log.info('Message received', { type: message.type });

  if (message.type === 'TOGGLE_INSPECT_MODE') {
    userToggled = true;
    if (!overlayInstance) {
      activateOverlay();
    } else {
      log.info('Deactivating Pinokio Overlay...');
      overlayInstance.destroy();
      overlayInstance = null;
      void writeTabState({ active: false });
    }
  }
});
