import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
export const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://gitvault.test' });
for (const name of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'CustomEvent', 'localStorage']) Object.defineProperty(globalThis, name, { value: (dom.window as any)[name], configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
