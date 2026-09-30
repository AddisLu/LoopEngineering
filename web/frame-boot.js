// Every shell page: the left rail (the item from <body data-nav="…">) and "你是 …" in the top bar.
// A module loaded after the page's own scripts, so classic pages (plans.js, morning.js, task.js)
// get exactly the same chrome as the module pages.
import { mountRail, mountWho } from './frame.js';

mountRail(document.body.dataset.nav || '');
mountWho();
