/*global chrome */

(function() {
    'use strict';

    // Utility functions moved from utils.js for Manifest V3 compatibility
    var utils = {
        getHashVariable: function(key, urlStr) {
            var valuesByKey = {},
                keyPairRegEx = /^(.+)=(.+)/,
                hashStr;

            if (!urlStr || urlStr.length === 0 || urlStr.indexOf('#') === -1) {
                return false;
            }

            //extract hash component from url
            hashStr = urlStr.replace(/^[^#]+#+(.*)/, '$1');

            if (hashStr.length === 0) {
                return false;
            }

            hashStr.split('&').forEach(function(keyPair) {
                if (keyPair && keyPair.match(keyPairRegEx)) {
                    valuesByKey[
                        keyPair.replace(keyPairRegEx, '$1')
                    ] = keyPair.replace(keyPairRegEx, '$2');
                }
            });
            return valuesByKey[key] || false;
        }
    };

    var UNSAVED_SESSION = 'Untitled space',
        NO_HOTKEY = 'none';

    var nodes = {},
        globalCurrentSpace,
        globalTabId = false,
        globalUrl = false,
        globalWindowId = false,
        globalSessionName = false;

    /*
     * POPUP INIT
     */

    // Keep track of popup window opener
    var isPopupWindow = false;
    var keepAliveInterval = null;

    document.addEventListener('DOMContentLoaded', async function() {
        console.log('DOMContentLoaded event fired');
        
        var url = utils.getHashVariable('url', window.location.href);
        globalUrl = url !== '' ? decodeURIComponent(url) : false;
        var windowId = utils.getHashVariable('windowId', window.location.href);
        globalWindowId = windowId !== '' ? windowId : false;
        globalTabId = utils.getHashVariable('tabId', window.location.href);
        var sessionName = utils.getHashVariable('sessionName', window.location.href);
        globalSessionName =
            sessionName && sessionName !== 'false' ? sessionName : false;
        var action = utils.getHashVariable('action', window.location.href);
        var opener = utils.getHashVariable('opener', window.location.href);
        
        // Check if this is a popup window opened by shortcuts
        isPopupWindow = opener && opener === 'bg';

        console.log('Popup variables parsed:', {
            url: globalUrl,
            windowId: globalWindowId,
            tabId: globalTabId,
            sessionName: globalSessionName,
            action: action,
            opener: opener,
            isPopupWindow: isPopupWindow
        });

        // For popup windows, start keep-alive mechanism
        if (isPopupWindow) {
            console.log('[Popup] Starting keep-alive for popup window');
            startKeepAlive();
        }

        // Ensure service worker is responsive before making requests
        await ensureServiceWorkerAlive();

        // Determine the correct window to get space data for
        if (globalWindowId) {
            // Shortcut popup - use the provided windowId
            console.log('[Popup] Using provided windowId:', globalWindowId);
            requestSpaceData(parseInt(globalWindowId), action);
        } else {
            // Extension popup - get the active tab's window instead of using getCurrent()
            console.log('[Popup] Extension popup - getting active tab window');
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
                    console.log('[Popup] Could not get active tab, falling back to current window');
                    requestSpaceData(null, action);
                } else {
                    const activeTab = tabs[0];
                    console.log('[Popup] Using active tab window:', activeTab.windowId);
                    requestSpaceData(activeTab.windowId, action);
                }
            });
        }
    });

    function requestSpaceData(windowId, action) {
        // Request space data from background via message passing
        var requestMessage = windowId
            ? { action: 'requestSpaceDetail', windowId: windowId }
            : { action: 'requestSpaceDetail' };

        console.log('Sending message to background:', requestMessage);

        chrome.runtime.sendMessage(requestMessage, function(space) {
            console.log('Received response from background:', space);
            
            if (chrome.runtime.lastError) {
                console.log('Connection error:', chrome.runtime.lastError.message);
                // Set a default space object to prevent errors
                globalCurrentSpace = { name: 'Default Space', tabs: [], windowId: null, sessionId: null };
            } else {
                globalCurrentSpace = space;
            }
            
            console.log('About to call renderCommon()');
            renderCommon();
            
            console.log('About to call routeView() with action:', action);
            routeView(action);
        });
    }

    function startKeepAlive() {
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
        }
        
        keepAliveInterval = setInterval(() => {
            console.log('[Popup] Sending keep-alive ping');
            chrome.runtime.sendMessage({ action: 'keepAlive' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('[Popup] Keep-alive failed:', chrome.runtime.lastError.message);
                } else {
                    console.log('[Popup] Keep-alive response:', response);
                }
            });
        }, 3000); // Send every 3 seconds
    }

    function ensureServiceWorkerAlive() {
        return new Promise((resolve) => {
            console.log('[Popup] Checking service worker responsiveness');
            chrome.runtime.sendMessage({ action: 'keepAlive' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('[Popup] Service worker not responding:', chrome.runtime.lastError.message);
                    // Wait a bit and try again
                    setTimeout(() => {
                        chrome.runtime.sendMessage({ action: 'keepAlive' }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.log('[Popup] Service worker still not responding');
                            } else {
                                console.log('[Popup] Service worker responsive after retry');
                            }
                            resolve();
                        });
                    }, 1000);
                } else {
                    console.log('[Popup] Service worker is responsive:', response);
                    resolve();
                }
            });
        });
    }

    // Clean up keep-alive when popup closes
    window.addEventListener('beforeunload', () => {
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
        }
    });

    function routeView(action) {
        console.log('routeView called with action:', action);
        
        if (action === 'move') {
            console.log('Routing to renderMoveCard()');
            renderMoveCard();
        } else if (action === 'switch') {
            console.log('Routing to renderSwitchCard()');
            renderSwitchCard();
        } else {
            console.log('Routing to renderMainCard() (default)');
            renderMainCard();
        }
    }

    /*
     * COMMON
     */

    function renderCommon() {
        console.log('renderCommon called with globalCurrentSpace:', globalCurrentSpace);
        
        document.getElementById(
            'activeSpaceTitle'
        ).value = globalCurrentSpace.name
            ? globalCurrentSpace.name
            : UNSAVED_SESSION;

        document.querySelector('body').onkeyup = function(e) {
            //listen for escape key
            if (e.keyCode === 27) {
                handleCloseAction();
                // } else if (e.keyCode === 13) {
                //     handleNameSave();
            }
        };
        document
            .getElementById('spaceEdit')
            .addEventListener('click', function(e) {
                handleNameEdit();
            });
        document
            .getElementById('activeSpaceTitle')
            .addEventListener('focus', function(e) {
                handleNameEdit();
            });
        document.getElementById('activeSpaceTitle').onkeyup = function(e) {
            //listen for enter key
            if (e.keyCode === 13) {
                document.getElementById('activeSpaceTitle').blur();
            }
        };
        document
            .getElementById('activeSpaceTitle')
            .addEventListener('blur', function(e) {
                handleNameSave();
            });
        
        console.log('renderCommon completed');
    }

    function handleCloseAction() {
        const opener = utils.getHashVariable('opener', window.location.href);
        if (opener && opener === 'bg') {
            chrome.runtime.sendMessage({
                action: 'requestClose',
            });
        } else {
            window.close();
        }
    }

    /*
     * MAIN POPUP VIEW
     */

    function renderMainCard() {
        console.log('Rendering main card');
        chrome.runtime.sendMessage({ action: 'requestHotkeys' }, function(hotkeys) {
            if (chrome.runtime.lastError) {
                console.log('Error getting hotkeys:', chrome.runtime.lastError.message);
                // Set default values
                hotkeys = { switchCode: NO_HOTKEY, moveCode: NO_HOTKEY };
            }
            
            document.querySelector(
                '#switcherLink .hotkey'
            ).innerHTML = hotkeys.switchCode
                ? hotkeys.switchCode
                : NO_HOTKEY;
            document.querySelector(
                '#moverLink .hotkey'
            ).innerHTML = hotkeys.moveCode ? hotkeys.moveCode : NO_HOTKEY;
        });

        var hotkeyEls = document.querySelectorAll('.hotkey');
        for (var i = 0; i < hotkeyEls.length; i++) {
            hotkeyEls[i].addEventListener('click', function(e) {
                chrome.runtime.sendMessage({
                    action: 'requestShowKeyboardShortcuts',
                }, function() {
                    if (chrome.runtime.lastError) {
                        console.log('Error showing keyboard shortcuts:', chrome.runtime.lastError.message);
                    }
                });
                window.close();
            });
        }

        document
            .querySelector('#allSpacesLink .optionText')
            .addEventListener('click', function(e) {
                console.log('Manage spaces clicked - sending requestShowSpaces message');
                chrome.runtime.sendMessage({
                    action: 'requestShowSpaces',
                }, function() {
                    if (chrome.runtime.lastError) {
                        console.log('Error showing spaces:', chrome.runtime.lastError.message);
                    } else {
                        console.log('requestShowSpaces message sent successfully');
                    }
                });
                window.close();
            });
        document
            .querySelector('#switcherLink .optionText')
            .addEventListener('click', function(e) {
                chrome.runtime.sendMessage(
                    { action: 'generatePopupParams', popupAction: 'switch' },
                    function(params) {
                        if (chrome.runtime.lastError) {
                            console.log('Error generating popup params:', chrome.runtime.lastError.message);
                            return;
                        }
                        if (!params) return;
                        window.location.hash = params;
                        window.location.reload();
                    }
                );
            });
        document
            .querySelector('#moverLink .optionText')
            .addEventListener('click', function(e) {
                chrome.runtime.sendMessage(
                    { action: 'generatePopupParams', popupAction: 'move' },
                    function(params) {
                        if (chrome.runtime.lastError) {
                            console.log('Error generating popup params:', chrome.runtime.lastError.message);
                            return;
                        }
                        if (!params) return;
                        window.location.hash = params;
                        window.location.reload();
                    }
                );
            });
    }

    function handleNameEdit() {
        var inputEl = document.getElementById('activeSpaceTitle');
        inputEl.focus();
        if (inputEl.value === UNSAVED_SESSION) {
            inputEl.value = '';
        }
    }

    function handleNameSave() {
        var inputEl = document.getElementById('activeSpaceTitle'),
            newName = inputEl.value;

        if (
            newName === UNSAVED_SESSION ||
            newName === globalCurrentSpace.name
        ) {
            return;
        }

        if (globalCurrentSpace.sessionId) {
            chrome.runtime.sendMessage(
                {
                    action: 'updateSessionName',
                    sessionName: newName,
                    sessionId: globalCurrentSpace.sessionId,
                },
                function() {}
            );
        } else {
            chrome.runtime.sendMessage(
                {
                    action: 'saveNewSession',
                    sessionName: newName,
                    windowId: globalCurrentSpace.windowId,
                },
                function() {}
            );
        }
    }

    /*
     * SWITCHER VIEW
     */

    function renderSwitchCard() {
        document.getElementById(
            'popupContainer'
        ).innerHTML = document.getElementById('switcherTemplate').innerHTML;
        chrome.runtime.sendMessage({ action: 'requestAllSpaces' }, function(
            spaces
        ) {
            if (chrome.runtime.lastError) {
                console.log('Error getting spaces:', chrome.runtime.lastError.message);
                spaces = []; // Default to empty array
            }
            
            spacesRenderer.initialise(8, true);
            spacesRenderer.renderSpaces(spaces);

            document.getElementById('spaceSelectForm').onsubmit = function(e) {
                e.preventDefault();
                handleSwitchAction(getSelectedSpace());
            };

            var allSpaceEls = document.querySelectorAll('.space');
            Array.prototype.forEach.call(allSpaceEls, function(el) {
                el.onclick = function(e) {
                    handleSwitchAction(el);
                };
            });
        });
    }

    function getSelectedSpace() {
        return document.querySelector('.space.selected');
    }

    async function handleSwitchAction(selectedSpaceEl) {
        console.log('[Popup] Handling switch action for element:', selectedSpaceEl);
        
        // For popup windows, ensure service worker is alive before switching
        if (isPopupWindow) {
            console.log('[Popup] Ensuring service worker is alive before switching');
            await ensureServiceWorkerAlive();
        }
        
        const sessionId = selectedSpaceEl.getAttribute('data-sessionId');
        const windowId = selectedSpaceEl.getAttribute('data-windowId');
        
        console.log('[Popup] Switching to space - sessionId:', sessionId, 'windowId:', windowId);
        
        chrome.runtime.sendMessage({
            action: 'switchToSpace',
            sessionId: sessionId,
            windowId: windowId,
        }, function(response) {
            if (chrome.runtime.lastError) {
                console.log('[Popup] Error switching space:', chrome.runtime.lastError.message);
            } else {
                console.log('[Popup] Switch space response:', response);
            }
        });
        
        // For popup windows, let the service worker handle closing
        // For regular extension popups, close immediately
        if (!isPopupWindow) {
            window.close();
        }
    }

    /*
     * MOVE VIEW
     */

    function renderMoveCard() {
        document.getElementById(
            'popupContainer'
        ).innerHTML = document.getElementById('moveTemplate').innerHTML;

        //initialise global handles to key elements (singletons)
        //nodes.home = document.getElementById('spacesHome');
        nodes.body = document.querySelector('body');
        nodes.spaceEditButton = document.getElementById('spaceEdit');
        nodes.moveForm = document.getElementById('spaceSelectForm');
        nodes.moveInput = document.getElementById('sessionsInput');
        nodes.activeSpaceTitle = document.getElementById('activeSpaceTitle');
        nodes.activeTabTitle = document.getElementById('activeTabTitle');
        nodes.activeTabFavicon = document.getElementById('activeTabFavicon');
        nodes.okButton = document.getElementById('moveBtn');
        nodes.cancelButton = document.getElementById('cancelBtn');

        //nodes.home.setAttribute('href', chrome.extension.getURL('spaces.html'));

        nodes.moveForm.onsubmit = function(e) {
            e.preventDefault();
            handleSelectAction();
        };

        nodes.body.onkeyup = function(e) {
            //highlight ok button when you start typing
            if (nodes.moveInput.value.length > 0) {
                nodes.okButton.className = 'button okBtn selected';
            } else {
                nodes.okButton.className = 'button okBtn';
            }

            //listen for escape key
            if (e.keyCode === 27) {
                handleCloseAction();
                return;
            }
        };

        nodes.spaceEditButton.onclick = function(e) {
            handleEditSpace();
        };
        nodes.okButton.onclick = function(e) {
            handleSelectAction();
        };
        nodes.cancelButton.onclick = function(e) {
            handleCloseAction();
        };

        //update currentSpaceDiv
        //nodes.windowTitle.innerHTML = "Current space: " + (globalSessionName ? globalSessionName : 'unnamed');
        nodes.activeSpaceTitle.innerHTML = globalSessionName
            ? globalSessionName
            : '(unnamed)';
        //selectSpace(nodes.activeSpace);

        updateTabDetails();

        chrome.runtime.sendMessage(
            {
                action: 'requestAllSpaces',
            },
            function(spaces) {
                if (chrome.runtime.lastError) {
                    console.log('Error getting spaces for move:', chrome.runtime.lastError.message);
                    spaces = []; // Default to empty array
                }
                
                //remove currently visible space
                spaces = spaces.filter(function(space) {
                    return space.windowId != globalWindowId; //loose matching here
                });
                spacesRenderer.initialise(5, false);
                spacesRenderer.renderSpaces(spaces);

                var allSpaceEls = document.querySelectorAll('.space');
                Array.prototype.forEach.call(allSpaceEls, function(el) {
                    el.onclick = function(e) {
                        handleSelectAction(el);
                    };
                });
            }
        );
    }

    function updateTabDetails() {
        var faviconSrc, cleanUrl;

        //if we are working with an open chrome tab
        if (globalTabId) {
            chrome.runtime.sendMessage(
                {
                    action: 'requestTabDetail',
                    tabId: globalTabId,
                },
                function(tab) {
                    if (tab) {
                        nodes.activeTabTitle.innerHTML = tab.title;

                        //try to get best favicon url path
                        if (
                            tab.favIconUrl &&
                            tab.favIconUrl.indexOf('chrome://theme') < 0
                        ) {
                            faviconSrc = tab.favIconUrl;
                        } else {
                            faviconSrc = 'chrome://favicon/' + tab.url;
                        }
                        nodes.activeTabFavicon.setAttribute('src', faviconSrc);

                        nodes.moveInput.setAttribute(
                            'placeholder',
                            'Move tab to..'
                        );

                        //nodes.windowTitle.innerHTML = tab.title;
                        //nodes.windowFavicon.setAttribute('href', faviconSrc);
                    }
                }
            );

            //else if we are dealing with a url only
        } else if (globalUrl) {
            cleanUrl =
                globalUrl.indexOf('://') > 0
                    ? globalUrl.substr(
                          globalUrl.indexOf('://') + 3,
                          globalUrl.length
                      )
                    : globalUrl;
            nodes.activeTabTitle.innerHTML = cleanUrl;
            nodes.activeTabFavicon.setAttribute('src', '/img/new.png');

            nodes.moveInput.setAttribute('placeholder', 'Add tab to..');
        }
    }

    function handleSelectAction() {
        var selectedSpaceEl = document.querySelector('.space.selected'),
            sessionId = selectedSpaceEl.getAttribute('data-sessionId'),
            windowId = selectedSpaceEl.getAttribute('data-windowId'),
            newSessionName = nodes.moveInput.value,
            params = {};

        if (sessionId && sessionId !== 'false') {
            params.sessionId = sessionId;

            if (globalTabId) {
                params.action = 'moveTabToSession';
                params.tabId = globalTabId;
            } else if (globalUrl) {
                params.action = 'addLinkToSession';
                params.url = globalUrl;
            }
        } else if (windowId && windowId !== 'false') {
            params.windowId = windowId;

            if (globalTabId) {
                params.action = 'moveTabToWindow';
                params.tabId = globalTabId;
            } else if (globalUrl) {
                params.action = 'addLinkToWindow';
                params.url = globalUrl;
            }
        } else {
            params.sessionName = newSessionName;

            if (globalTabId) {
                params.action = 'moveTabToNewSession';
                params.tabId = globalTabId;
            } else if (globalUrl) {
                params.action = 'addLinkToNewSession';
                params.url = globalUrl;
            }
        }

        chrome.runtime.sendMessage(params);
        //this window will be closed by background script
    }
    function handleEditSpace() {
        chrome.runtime.sendMessage({
            action: 'requestShowSpaces',
            windowId: globalWindowId,
            edit: 'true',
        });
    }
})();
