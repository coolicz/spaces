// Import dependencies for service worker
importScripts('db.js', 'dbService.js', 'spacesService.js', 'utils.js');

/* spaces
 * Copyright (C) 2015 Dean Oemcke
 */

// Track initialization state
var isInitialized = false;

// eslint-disable-next-line no-unused-vars
var spaces = (function() {
    'use strict';

    var spacesPopupWindowId = false,
        spacesOpenWindowId = false,
        previousAllSpacesList = [],
        noop = function() {},
        debug = true; // Set to false to disable debug console logs

    //LISTENERS

    //add listeners for session monitoring
    chrome.tabs.onCreated.addListener(function(tab) {
        //this call to checkInternalSpacesWindows actually returns false when it should return true
        //due to the event being called before the globalWindowIds get set. oh well, never mind.
        if (checkInternalSpacesWindows(tab.windowId, false)) return;
        //don't need this listener as the tabUpdated listener also fires when a new tab is created
        //spacesService.handleTabCreated(tab);
        updateSpacesWindow('tabs.onCreated');
    });
    chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
        if (checkInternalSpacesWindows(removeInfo.windowId, false)) return;
        spacesService.handleTabRemoved(tabId, removeInfo, function() {
            updateSpacesWindow('tabs.onRemoved');
        });
    });
    chrome.tabs.onMoved.addListener(function(tabId, moveInfo) {
        if (checkInternalSpacesWindows(moveInfo.windowId, false)) return;
        
        if (debug) console.log('[SW] ========== TAB MOVED EVENT ==========');
        if (debug) console.log('[SW] Tab moved - updating session for reordering. Tab:', tabId, 'Window:', moveInfo.windowId);
        if (debug) console.log('[SW] Move info:', JSON.stringify(moveInfo));
        
        // Tab moves affect ordering, so always update tab groups/session data
        handleTabGroupChange(moveInfo.windowId, 'tab.moved.reorder');
        
        spacesService.handleTabMoved(tabId, moveInfo, function() {
            console.log('[SW] spacesService.handleTabMoved completed');
            updateSpacesWindow('tabs.onMoved');
        });
    });
    
    chrome.tabs.onAttached.addListener(function(tabId, attachInfo) {
        if (checkInternalSpacesWindows(attachInfo.newWindowId, false)) return;
        
        console.log('[SW] Tab attached to window - updating session. Tab:', tabId, 'Window:', attachInfo.newWindowId);
        
        // Tab attached to a window affects ordering
        handleTabGroupChange(attachInfo.newWindowId, 'tab.attached');
        updateSpacesWindow('tabs.onAttached');
    });
    
    chrome.tabs.onDetached.addListener(function(tabId, detachInfo) {
        if (checkInternalSpacesWindows(detachInfo.oldWindowId, false)) return;
        
        console.log('[SW] Tab detached from window - updating session. Tab:', tabId, 'Old Window:', detachInfo.oldWindowId);
        
        // Tab detached from a window affects ordering
        handleTabGroupChange(detachInfo.oldWindowId, 'tab.detached');
        updateSpacesWindow('tabs.onDetached');
    });
    chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
        if (checkInternalSpacesWindows(tab.windowId, false)) return;

        // Check if this is a tab group change (tab moving to/from groups)
        if (changeInfo.groupId !== undefined) {
            console.log('[SW] Tab group change detected - Tab:', tabId, 'New groupId:', changeInfo.groupId);
            handleTabGroupChange(tab.windowId, 'tab.groupId.changed');
        }

        spacesService.handleTabUpdated(tab, changeInfo, function() {
            updateSpacesWindow('tabs.onUpdated');
        });
    });

    // Tab Group Event Listeners
    chrome.tabGroups.onCreated.addListener(function(group) {
        console.log('[SW] Tab group created:', group.id, 'in window:', group.windowId);
        if (checkInternalSpacesWindows(group.windowId, false)) return;
        handleTabGroupChange(group.windowId, 'tabGroups.onCreated');
    });

    chrome.tabGroups.onRemoved.addListener(function(group) {
        console.log('[SW] Tab group removed:', group.id, 'from window:', group.windowId);
        if (checkInternalSpacesWindows(group.windowId, false)) return;
        handleTabGroupChange(group.windowId, 'tabGroups.onRemoved');
    });

    chrome.tabGroups.onUpdated.addListener(function(group) {
        console.log('[SW] Tab group updated:', group.id, 'properties changed');
        if (checkInternalSpacesWindows(group.windowId, false)) return;
        handleTabGroupChange(group.windowId, 'tabGroups.onUpdated');
    });

    chrome.tabGroups.onMoved.addListener(function(group) {
        console.log('[SW] ========== TAB GROUP MOVED EVENT ==========');
        console.log('[SW] Tab group moved:', group.id, 'in window:', group.windowId);
        console.log('[SW] Group details:', JSON.stringify(group));
        if (checkInternalSpacesWindows(group.windowId, false)) return;
        handleTabGroupChange(group.windowId, 'tabGroups.onMoved');
    });

    chrome.windows.onRemoved.addListener(function(windowId) {
        if (checkInternalSpacesWindows(windowId, true)) return;
        spacesService.handleWindowRemoved(windowId, true, function() {
            updateSpacesWindow('windows.onRemoved');
        });

        //if this was the last window open and the spaces window is stil open
        //then close the spaces window also so that chrome exits fully
        //NOTE: this is a workaround for an issue with the chrome 'restore previous session' option
        //if the spaces window is the only window open and you try to use it to open a space,
        //when that space loads, it also loads all the windows from the window that was last closed
        chrome.windows.getAll({}, function(windows) {
            if (windows.length === 1 && spacesOpenWindowId) {
                chrome.windows.remove(spacesOpenWindowId);
            }
        });
    });
    //don't need this listener as the tabUpdated listener also fires when a new window is created
    /*chrome.windows.onCreated.addListener(function (window) {

        if (checkInternalSpacesWindows(window.id, false)) return;
        spacesService.handleWindowCreated(window);
    });*/

    //add listeners for tab and window focus changes
    //when a tab or window is changed, close the move tab popup if it is open
    chrome.windows.onFocusChanged.addListener(function(windowId) {
        // Prevent a click in the popup on Ubunto or ChroneOS from closing the
        // popup prematurely.
        if (
            windowId == chrome.windows.WINDOW_ID_NONE ||
            windowId == spacesPopupWindowId
        ) {
            return;
        }

        if (!debug && spacesPopupWindowId) {
            if (spacesPopupWindowId) {
                closePopupWindow();
            }
        }
        spacesService.handleWindowFocussed(windowId);
    });

    //add listeners for message requests from other extension pages (spaces.html & tab.html)

    chrome.runtime.onMessage.addListener(function(
        request,
        sender,
        sendResponse
    ) {
        if (debug) console.log('[SW] Service worker received message:', request.action, 'Initialized:', isInitialized);
        
        // Ensure service worker is initialized when receiving messages
        if (!isInitialized) {
            if (debug) console.log('[SW] Service worker not initialized, initializing now');
            initializeServiceWorker();
        }
        
        // Enhanced debugging for popup window communication
        if (debug && sender.tab && sender.tab.url && sender.tab.url.includes('popup.html')) {
            console.log('[SW] Message from popup window - Tab ID:', sender.tab.id, 'Window ID:', sender.tab.windowId);
            console.log('[SW] Current spacesPopupWindowId:', spacesPopupWindowId);
        }
        
        if (debug) {
            console.log('[SW] listener fired:' + JSON.stringify(request));
        }

        var sessionId, windowId, tabId;

        //endpoints called by spaces.js
        switch (request.action) {
            case 'loadSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId) {
                    handleLoadSession(sessionId);
                    sendResponse(true);
                }
                //close the requesting tab (should be spaces.html)
                //if (!debug) closeChromeTab(sender.tab.id);

                return true;
                break;

            case 'loadWindow':
                windowId = _cleanParameter(request.windowId);
                if (windowId) {
                    handleLoadWindow(windowId);
                    sendResponse(true);
                }
                //close the requesting tab (should be spaces.html)
                //if (!debug) closeChromeTab(sender.tab.id);

                return true;
                break;

            case 'loadTabInSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId && request.tabUrl) {
                    handleLoadSession(sessionId, request.tabUrl);
                    sendResponse(true);
                }
                //close the requesting tab (should be spaces.html)
                //if (!debug) closeChromeTab(sender.tab.id);

                return true;
                break;

            case 'loadTabInWindow':
                windowId = _cleanParameter(request.windowId);
                if (windowId && request.tabUrl) {
                    handleLoadWindow(windowId, request.tabUrl);
                    sendResponse(true);
                }
                //close the requesting tab (should be spaces.html)
                //if (!debug) closeChromeTab(sender.tab.id);

                return true;
                break;

            case 'saveNewSession':
                windowId = _cleanParameter(request.windowId);
                if (windowId && request.sessionName) {
                    handleSaveNewSession(
                        windowId,
                        request.sessionName,
                        sendResponse
                    );
                }
                return true; //allow async response
                break;

            case 'importNewSession':
                if (request.urlList) {
                    handleImportNewSession(request.urlList, sendResponse);
                }
                return true; //allow async response
                break;

            case 'restoreFromBackup':
                if (request.spaces) {
                    handleRestoreFromBackup(request.spaces, sendResponse);
                }
                return true; //allow async response
                break;

            case 'deleteSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId) {
                    handleDeleteSession(sessionId, false, sendResponse);
                }
                return true;
                break;

            case 'keepAlive':
                console.log('[SW] Received keepAlive ping');
                sendResponse(true);
                break;

            case 'updateSessionName':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId && request.sessionName) {
                    handleUpdateSessionName(
                        sessionId,
                        request.sessionName,
                        sendResponse
                    );
                }
                return true;
                break;

            case 'requestSpaceDetail':
                console.log('Processing requestSpaceDetail message');
                windowId = _cleanParameter(request.windowId);
                sessionId = _cleanParameter(request.sessionId);

                console.log('requestSpaceDetail - windowId:', windowId, 'sessionId:', sessionId);

                if (windowId) {
                    console.log('Checking if windowId is internal spaces window');
                    if (checkInternalSpacesWindows(windowId, false)) {
                        console.log('Internal spaces window detected, sending false');
                        sendResponse(false);
                    } else {
                        console.log('Calling requestSpaceFromWindowId');
                        requestSpaceFromWindowId(windowId, sendResponse);
                    }
                } else if (sessionId) {
                    console.log('Calling requestSpaceFromSessionId');
                    requestSpaceFromSessionId(sessionId, sendResponse);
                } else {
                    console.log('No windowId or sessionId provided, calling requestCurrentSpace');
                    requestCurrentSpace(sendResponse);
                }
                return true;
                break;

            //end points called by tag.js and switcher.js
            //note: some of these endpoints will close the requesting tab
            case 'requestAllSpaces':
                requestAllSpaces(function(allSpaces) {
                    previousAllSpacesList = allSpaces;
                    sendResponse(allSpaces);
                });
                return true;
                break;

            case 'requestHotkeys':
                requestHotkeys(sendResponse);
                return true;
                break;

            case 'requestTabDetail':
                tabId = _cleanParameter(request.tabId);
                if (tabId) {
                    requestTabDetail(tabId, function(tab) {
                        if (tab) {
                            sendResponse(tab);
                        } else {
                            //close the requesting tab (should be tab.html)
                            closePopupWindow();
                        }
                    });
                }
                return true;
                break;

            case 'requestShowSpaces':
                windowId = _cleanParameter(request.windowId);

                //show the spaces tab in edit mode for the passed in windowId
                if (windowId) {
                    showSpacesOpenWindow(windowId, request.edit);
                } else {
                    showSpacesOpenWindow();
                }
                return false;
                break;

            case 'requestShowSwitcher':
                showSpacesSwitchWindow();
                return false;
                break;

            case 'requestShowMover':
                showSpacesMoveWindow();
                return false;
                break;

            case 'requestShowKeyboardShortcuts':
                createShortcutsWindow();
                return false;
                break;

            case 'requestClose':
                //close the requesting tab (should be tab.html)
                closePopupWindow();
                return false;
                break;

            case 'switchToSpace':
                windowId = _cleanParameter(request.windowId);
                sessionId = _cleanParameter(request.sessionId);
                
                console.log('[SW] switchToSpace request - windowId:', windowId, 'sessionId:', sessionId);

                if (windowId) {
                    console.log('[SW] Switching to window:', windowId);
                    handleLoadWindow(windowId);
                    
                    // For popup windows, we need to close the popup after switching
                    setTimeout(() => {
                        if (spacesPopupWindowId) {
                            console.log('[SW] Closing popup window after switch');
                            closePopupWindow();
                        }
                    }, 100);
                } else if (sessionId) {
                    console.log('[SW] Switching to session:', sessionId);
                    handleLoadSession(sessionId);
                    
                    // For popup windows, we need to close the popup after switching  
                    setTimeout(() => {
                        if (spacesPopupWindowId) {
                            console.log('[SW] Closing popup window after switch');
                            closePopupWindow();
                        }
                    }, 100);
                }

                return false;
                break;

            case 'addLinkToNewSession':
                tabId = _cleanParameter(request.tabId);
                if (request.sessionName && request.url) {
                    handleAddLinkToNewSession(
                        request.url,
                        request.sessionName,
                        function(result) {
                            if (result)
                                updateSpacesWindow('addLinkToNewSession');

                            //close the requesting tab (should be tab.html)
                            closePopupWindow();
                        }
                    );
                }
                return false;
                break;

            case 'moveTabToNewSession':
                tabId = _cleanParameter(request.tabId);
                if (request.sessionName && tabId) {
                    handleMoveTabToNewSession(
                        tabId,
                        request.sessionName,
                        function(result) {
                            if (result)
                                updateSpacesWindow('moveTabToNewSession');

                            //close the requesting tab (should be tab.html)
                            closePopupWindow();
                        }
                    );
                }
                return false;
                break;

            case 'addLinkToSession':
                sessionId = _cleanParameter(request.sessionId);

                if (sessionId && request.url) {
                    handleAddLinkToSession(request.url, sessionId, function(
                        result
                    ) {
                        if (result) updateSpacesWindow('addLinkToSession');

                        //close the requesting tab (should be tab.html)
                        closePopupWindow();
                    });
                }
                return false;
                break;

            case 'moveTabToSession':
                sessionId = _cleanParameter(request.sessionId);
                tabId = _cleanParameter(request.tabId);

                if (sessionId && tabId) {
                    handleMoveTabToSession(tabId, sessionId, function(result) {
                        if (result) updateSpacesWindow('moveTabToSession');

                        //close the requesting tab (should be tab.html)
                        closePopupWindow();
                    });
                }
                return false;
                break;

            case 'addLinkToWindow':
                windowId = _cleanParameter(request.windowId);

                if (windowId && request.url) {
                    handleAddLinkToWindow(request.url, windowId, function(
                        result
                    ) {
                        if (result) updateSpacesWindow('addLinkToWindow');

                        //close the requesting tab (should be tab.html)
                        closePopupWindow();
                    });
                }
                return false;
                break;

            case 'moveTabToWindow':
                windowId = _cleanParameter(request.windowId);
                tabId = _cleanParameter(request.tabId);

                if (windowId && tabId) {
                    handleMoveTabToWindow(tabId, windowId, function(result) {
                        if (result) updateSpacesWindow('moveTabToWindow');

                        //close the requesting tab (should be tab.html)
                        closePopupWindow();
                    });
                }
                return false;
                break;

            case 'generatePopupParams':
                if (request.popupAction) {
                    generatePopupParams(request.popupAction).then(function(params) {
                        sendResponse(params);
                    });
                }
                return true; //allow async response
                break;

            case 'keepAlive':
                // Keep service worker alive - especially for popup windows
                console.log('[SW] Keep alive ping received');
                sendResponse({ status: 'alive', timestamp: Date.now() });
                return true;
                break;

            default:
                console.log('[SW] Unknown message action:', request.action);
                return false;
                break;
        }
    });
    function _cleanParameter(param) {
        if (typeof param === 'number') {
            return param;
        } else if (param === 'false') {
            return false;
        } else if (param === 'true') {
            return true;
        } else {
            return parseInt(param, 10);
        }
    }

    //add listeners for keyboard commands

    chrome.commands.onCommand.addListener(function(command) {
        //handle showing the move tab popup (tab.html)
        if (command === 'spaces-move') {
            showSpacesMoveWindow();

            //handle showing the switcher tab popup (switcher.html)
        } else if (command === 'spaces-switch') {
            showSpacesSwitchWindow();
        }
    });

    // Context menu click listener
    chrome.contextMenus.onClicked.addListener(function(info, tab) {
        //handle showing the move tab popup (tab.html)
        if (info.menuItemId === 'spaces-add-link') {
            showSpacesMoveWindow(info.linkUrl);
        }
    });

    //runtime extension install listener
    chrome.runtime.onInstalled.addListener(function(details) {
        // Create context menu entry (this prevents duplicates)
        chrome.contextMenus.create({
            id: 'spaces-add-link',
            title: 'Add link to space...',
            contexts: ['link'],
        }, function() {
            if (chrome.runtime.lastError) {
                console.log('Context menu creation error:', chrome.runtime.lastError.message);
            }
        });

        if (details.reason == 'install') {
            console.log('This is a first install!');
            showSpacesOpenWindow();
        } else if (details.reason == 'update') {
            var thisVersion = chrome.runtime.getManifest().version;
            if (details.previousVersion !== thisVersion) {
                console.log(
                    'Updated from ' +
                        details.previousVersion +
                        ' to ' +
                        thisVersion +
                        '!'
                );
            }
        }
    });

    function createShortcutsWindow() {
        chrome.tabs.create({ url: 'chrome://extensions/configureCommands' });
    }

    function showSpacesOpenWindow(windowId, editMode) {
        var url;

        if (editMode && windowId) {
            url = chrome.runtime.getURL(
                'spaces.html#windowId=' + windowId + '&editMode=true'
            );
        } else {
            url = chrome.runtime.getURL('spaces.html');
        }

        console.log('showSpacesOpenWindow called with URL:', url);

        //if spaces open window already exists then just give it focus (should be up to date)
        if (spacesOpenWindowId) {
            console.log('Existing spaces window found, updating:', spacesOpenWindowId);
            chrome.windows.get(spacesOpenWindowId, { populate: true }, function(
                window
            ) {
                if (chrome.runtime.lastError) {
                    console.log('Error getting existing spaces window:', chrome.runtime.lastError.message);
                    // Reset the window ID and try creating a new one
                    spacesOpenWindowId = false;
                    showSpacesOpenWindow(windowId, editMode);
                    return;
                }
                
                chrome.windows.update(spacesOpenWindowId, { focused: true }, function() {
                    if (chrome.runtime.lastError) {
                        console.log('Error focusing spaces window:', chrome.runtime.lastError.message);
                    }
                });
                
                if (window && window.tabs && window.tabs[0] && window.tabs[0].id) {
                    chrome.tabs.update(window.tabs[0].id, { url: url }, function() {
                        if (chrome.runtime.lastError) {
                            console.log('Error updating spaces tab URL:', chrome.runtime.lastError.message);
                        }
                    });
                }
            });

            //otherwise re-create it
        } else {
            console.log('Creating new spaces window...');
            chrome.windows.create(
                {
                    type: 'popup',
                    url: url,
                    height: 700,
                    width: Math.min(1000, 1000),
                    top: 0,
                    left: 0,
                },
                function(window) {
                    if (chrome.runtime.lastError) {
                        console.log('Error creating spaces window:', chrome.runtime.lastError.message);
                        return;
                    }
                    
                    if (window) {
                        spacesOpenWindowId = window.id;
                        console.log('Spaces window created successfully with ID:', window.id);
                    } else {
                        console.log('Window creation returned null/undefined');
                    }
                }
            );
        }
    }
    function showSpacesMoveWindow(tabUrl) {
        createOrShowSpacesPopupWindow('move', tabUrl);
    }
    function showSpacesSwitchWindow() {
        createOrShowSpacesPopupWindow('switch');
    }

    async function generatePopupParams(action, tabUrl) {
        //get currently highlighted tab
        const tabs = await new Promise(resolve => {
            chrome.tabs.query({ active: true, currentWindow: true }, resolve);
        });

        if (tabs.length === 0) return;

        var activeTab = tabs[0],
            name,
            url,
            session;

        //make sure that the active tab is not from an internal spaces window
        if (checkInternalSpacesWindows(activeTab.windowId, false)) {
            return;
        }

        session = spacesService.getSessionByWindowId(activeTab.windowId);

        name = session ? session.name : '';

        var params =
            'action=' +
            action +
            '&windowId=' +
            activeTab.windowId +
            '&sessionName=' +
            name;

        if (tabUrl) {
            params += '&url=' + encodeURIComponent(tabUrl);
        } else {
            params += '&tabId=' + activeTab.id;
        }
        return params;
    }

    function createOrShowSpacesPopupWindow(action, tabUrl) {
        // Keep service worker alive during popup window interaction
        console.log('[SW] Creating or showing spaces popup window');
        
        generatePopupParams(action, tabUrl).then(params => {
            const popupUrl = `${chrome.runtime.getURL(
                'popup.html'
            )}#opener=bg&${params}`;
            
            console.log('[SW] Popup URL generated:', popupUrl);
            
            //if spaces  window already exists
            if (spacesPopupWindowId) {
                console.log('[SW] Updating existing popup window:', spacesPopupWindowId);
                chrome.windows.get(
                    spacesPopupWindowId,
                    { populate: true },
                    function(window) {
                        if (chrome.runtime.lastError) {
                            console.log('[SW] Error getting existing window:', chrome.runtime.lastError);
                            spacesPopupWindowId = null;
                            // Retry creating new window
                            createNewPopupWindow(popupUrl);
                            return;
                        }
                        
                        //if window is currently focused then don't update
                        if (window.focused) {
                            console.log('[SW] Window already focused, not updating');
                            return;

                            //else update popupUrl and give it focus
                        } else {
                            console.log('[SW] Focusing existing window');
                            chrome.windows.update(spacesPopupWindowId, {
                                focused: true,
                            });
                            if (window.tabs[0].id) {
                                chrome.tabs.update(window.tabs[0].id, {
                                    url: popupUrl,
                                });
                            }
                        }
                    }
                );

                //otherwise create it
            } else {
                createNewPopupWindow(popupUrl);
            }
        });
    }
    
    function createNewPopupWindow(popupUrl) {
        console.log('[SW] Creating new popup window');
        
        // Get the currently active window to position popup relative to it
        chrome.windows.getCurrent((currentWindow) => {
            if (!currentWindow) {
                console.log('[SW] No current window found, using fallback positioning');
                // Fallback to screen positioning if no active window
                chrome.system.display.getInfo((displays) => {
                    const primaryDisplay = displays[0];
                    const windowWidth = 310;
                    const windowHeight = 450;
                    const margin = 20;
                    
                    const left = primaryDisplay.bounds.left + primaryDisplay.bounds.width - windowWidth - margin;
                    const top = primaryDisplay.bounds.top + primaryDisplay.bounds.height - windowHeight - margin;
                    
                    createPopupWindow(popupUrl, left, top, windowWidth, windowHeight);
                });
                return;
            }
            
            // Calculate bottom right position relative to the active window with 20px margins
            const windowWidth = 310;
            const windowHeight = 450;
            const margin = 20;
            
            const left = currentWindow.left + currentWindow.width - windowWidth - margin;
            const top = currentWindow.top + currentWindow.height - windowHeight - margin;
            
            console.log('[SW] Positioning popup at bottom right of active window - left:', left, 'top:', top);
            console.log('[SW] Active window bounds - left:', currentWindow.left, 'top:', currentWindow.top, 'width:', currentWindow.width, 'height:', currentWindow.height);
            
            createPopupWindow(popupUrl, left, top, windowWidth, windowHeight);
        });
    }
    
    function createPopupWindow(popupUrl, left, top, width, height) {
        chrome.windows.create(
            {
                type: 'popup',
                url: popupUrl,
                focused: true,
                height: height,
                width: width,
                top: top,
                left: left,
            },
            function(window) {
                if (chrome.runtime.lastError) {
                    console.log('[SW] Error creating popup window:', chrome.runtime.lastError);
                    return;
                }
                console.log('[SW] Popup window created with ID:', window.id);
                spacesPopupWindowId = window.id;
                
                // Set up a heartbeat to keep service worker alive while popup is open
                startPopupHeartbeat();
            }
        );
    }
    
    // Keep service worker alive while popup window is open
    let popupHeartbeatInterval = null;
    
    function startPopupHeartbeat() {
        if (popupHeartbeatInterval) {
            clearInterval(popupHeartbeatInterval);
        }
        
        console.log('[SW] Starting popup heartbeat');
        popupHeartbeatInterval = setInterval(() => {
            if (spacesPopupWindowId) {
                chrome.windows.get(spacesPopupWindowId, (window) => {
                    if (chrome.runtime.lastError || !window) {
                        console.log('[SW] Popup window closed, stopping heartbeat');
                        clearInterval(popupHeartbeatInterval);
                        popupHeartbeatInterval = null;
                        spacesPopupWindowId = null;
                    } else {
                        console.log('[SW] Popup heartbeat - keeping service worker alive');
                    }
                });
            } else {
                console.log('[SW] No popup window, stopping heartbeat');
                clearInterval(popupHeartbeatInterval);
                popupHeartbeatInterval = null;
            }
        }, 5000); // Check every 5 seconds
    }

    function closeChromeTab(tabId) {
        chrome.tabs.remove(tabId, function(result) {
            if (chrome.runtime.lastError) {
                console.log(chrome.runtime.lastError.message);
            }
        });
    }

    function closePopupWindow() {
        if (spacesPopupWindowId) {
            chrome.windows.get(
                spacesPopupWindowId,
                { populate: true },
                function(spacesWindow) {
                    //remove popup from history
                    if (
                        spacesWindow.tabs.length > 0 &&
                        spacesWindow.tabs[0].url
                    ) {
                        chrome.history.deleteUrl({
                            url: spacesWindow.tabs[0].url,
                        });
                    }

                    //remove popup window
                    chrome.windows.remove(spacesWindow.id, function(result) {
                        if (chrome.runtime.lastError) {
                            console.log(chrome.runtime.lastError.message);
                        }
                    });
                }
            );
        }
    }

    function updateSpacesWindow(source) {
        if (debug)
            console.log('updateSpacesWindow triggered. source: ' + source);

        // Only send update if spaces window is actually open
        if (!spacesOpenWindowId) {
            console.log('[SW] Spaces window not open, skipping updateSpaces message');
            return;
        }

        console.log('[SW] Sending updateSpaces message to spaces window:', spacesOpenWindowId);

        requestAllSpaces(function(allSpaces) {
            // Debug: Log the windowId values in allSpaces
            console.log('[SW] About to send updateSpaces with spaces:', allSpaces.map(space => ({
                sessionId: space.sessionId,
                name: space.name,
                windowId: space.windowId
            })));

            // Send message to specific tab in the spaces window
            chrome.tabs.query({ windowId: spacesOpenWindowId }, function(tabs) {
                if (chrome.runtime.lastError || !tabs || tabs.length === 0) {
                    console.log('[SW] Could not find tabs in spaces window');
                    return;
                }

                const spacesTab = tabs.find(tab => tab.url && tab.url.includes('spaces.html'));
                if (spacesTab) {
                    console.log('[SW] Sending updateSpaces to tab:', spacesTab.id, 'URL:', spacesTab.url);
                    chrome.tabs.sendMessage(spacesTab.id, {
                        action: 'updateSpaces',
                        spaces: allSpaces,
                    }).then(() => {
                        console.log('[SW] updateSpaces message sent successfully');
                    }).catch((error) => {
                        console.log('[SW] Error sending updateSpaces message to tab:', error.message);
                        
                        // Fallback to runtime.sendMessage as a backup
                        console.log('[SW] Trying fallback with chrome.runtime.sendMessage');
                        chrome.runtime.sendMessage({
                            action: 'updateSpaces',
                            spaces: allSpaces,
                        }).catch((fallbackError) => {
                            console.log('[SW] Fallback also failed:', fallbackError.message);
                        });
                    });
                } else {
                    console.log('[SW] No spaces.html tab found in spaces window');
                    console.log('[SW] Available tabs:', tabs.map(tab => ({ id: tab.id, url: tab.url })));
                }
            });
        });
    }

    function checkInternalSpacesWindows(windowId, windowClosed) {
        if (windowId === spacesOpenWindowId) {
            if (windowClosed) spacesOpenWindowId = false;
            return true;
        } else if (windowId === spacesPopupWindowId) {
            if (windowClosed) spacesPopupWindowId = false;
            return true;
        }
    }

    function checkSessionOverwrite(session) {
        //make sure session being overwritten is not currently open
        if (session.windowId) {
            console.log(
                "A session with the name '" +
                    session.name +
                    "' is currently open an cannot be overwritten"
            );
            return false;

            //otherwise prompt to see if user wants to overwrite session
        } else {
            console.log(
                'Replace existing space: ' + session.name + '?'
            );
            return true; // Default to true for service worker compatibility
        }
    }

    function checkSessionDelete(session) {
        console.log(
            'Are you sure you want to delete the space: ' + session.name + '?'
        );
        return true; // Default to true for service worker compatibility
    }

    function requestHotkeys(callback) {
        chrome.commands.getAll(function(commands) {
            var switchStr, moveStr, spacesStr;

            commands.forEach(function(command) {
                if (command.name === 'spaces-switch') {
                    switchStr = command.shortcut;
                } else if (command.name === 'spaces-move') {
                    moveStr = command.shortcut;
                } else if (command.name === 'spaces-open') {
                    spacesStr = command.shortcut;
                }
            });

            callback({
                switchCode: switchStr,
                moveCode: moveStr,
                spacesCode: spacesStr,
            });
        });
    }

    function requestTabDetail(tabId, callback) {
        chrome.tabs.get(tabId, callback);
    }

    function requestCurrentSpace(callback) {
        chrome.windows.getCurrent(function(window) {
            requestSpaceFromWindowId(window.id, callback);
        });
    }

    //returns a 'space' object which is essentially the same as a session object
    //except that includes space.sessionId (session.id) and space.windowId
    function requestSpaceFromWindowId(windowId, callback) {
        console.log('[SW] requestSpaceFromWindowId called with windowId:', windowId);
        
        //first check for an existing session matching this windowId
        var session = spacesService.getSessionByWindowId(windowId);

        if (session) {
            console.log('[SW] Found session for windowId:', windowId, 'Session:', {
                id: session.id,
                windowId: session.windowId,
                name: session.name
            });
            
            callback({
                sessionId: session.id,
                windowId: session.windowId,
                name: session.name,
                tabs: session.tabs,
                history: session.history,
                tabGroups: session.tabGroups || [], // Include tab groups
            });

            //otherwise build a space object out of the actual window
        } else {
            chrome.windows.get(windowId, { populate: true }, function(window) {
                //if failed to load requested window
                if (chrome.runtime.lastError) {
                    callback(false);
                } else {
                    // For live windows, get current tab groups
                    getTabGroupsForWindow(windowId, function(tabGroups) {
                        callback({
                            sessionId: false,
                            windowId: window.id,
                            name: false,
                            tabs: window.tabs,
                            history: false,
                            tabGroups: tabGroups, // Include current tab groups
                        });
                    });
                }
            });
        }
    }

    function requestSpaceFromSessionId(sessionId, callback) {
        if (debug) console.log('[SW] requestSpaceFromSessionId - Checking cache for session:', sessionId);

        // Try to get from cache first
        var cachedSession = spacesService.getSessionBySessionId(sessionId);
        
        if (cachedSession && cachedSession.tabs && cachedSession.tabs.length > 0) {
            // Cache hit - use cached data
            if (debug) console.log('[SW] requestSpaceFromSessionId - Using cached session data:', {
                id: cachedSession.id,
                name: cachedSession.name,
                windowId: cachedSession.windowId,
                tabsCount: cachedSession.tabs ? cachedSession.tabs.length : 'undefined',
                tabGroupsCount: cachedSession.tabGroups ? cachedSession.tabGroups.length : 'undefined'
            });

            callback({
                sessionId: cachedSession.id,
                windowId: cachedSession.windowId,
                name: cachedSession.name,
                tabs: cachedSession.tabs,
                history: cachedSession.history,
                tabGroups: cachedSession.tabGroups || [], // Include tab groups
            });
            return;
        }

        // Cache miss or incomplete data - fetch from database
        if (debug) console.log('[SW] requestSpaceFromSessionId - Cache miss, fetching from database for session:', sessionId);
        
        dbService.fetchSessionById(sessionId, function(freshSession) {
            if (!freshSession) {
                if (debug) console.log('[SW] Session not found in database:', sessionId);
                callback(false);
                return;
            }

            if (debug) console.log('[SW] requestSpaceFromSessionId - Fresh session from database:', {
                id: freshSession.id,
                name: freshSession.name,
                windowId: freshSession.windowId,
                tabsCount: freshSession.tabs ? freshSession.tabs.length : 'undefined',
                tabGroupsCount: freshSession.tabGroups ? freshSession.tabGroups.length : 'undefined'
            });

            // Update the in-memory cache with fresh data
            if (cachedSession) {
                cachedSession.tabs = freshSession.tabs;
                cachedSession.tabGroups = freshSession.tabGroups;
                cachedSession.name = freshSession.name;
                cachedSession.windowId = freshSession.windowId;
                cachedSession.lastAccess = freshSession.lastAccess;
                cachedSession.history = freshSession.history;
            }

            callback({
                sessionId: freshSession.id,
                windowId: freshSession.windowId,
                name: freshSession.name,
                tabs: freshSession.tabs,
                history: freshSession.history,
                tabGroups: freshSession.tabGroups || [], // Include tab groups
            });
        });
    }

    function requestAllSpaces(callback) {
        var sessions, allSpaces;

        if (debug) console.log('[SW] requestAllSpaces - Using cached session data with validation');

        chrome.windows.getAll({ populate: true }, function(windows) {
            sessions = spacesService.getAllSessions();

            // Quick validation: clear any stale windowIds from cache
            sessions.forEach(function(session) {
                if (session.windowId && session.windowId !== false) {
                    // Check if this window actually exists
                    var windowExists = windows.some(function(window) {
                        return window.id === session.windowId;
                    });
                    
                    if (!windowExists) {
                        if (debug) console.log('[SW] Clearing stale windowId from cache for session:', session.id, 'windowId:', session.windowId);
                        session.windowId = false;
                        // Save to database asynchronously
                        spacesService.saveExistingSession(session.id, function() {
                            if (debug) console.log('[SW] Saved session with cleared windowId');
                        });
                    }
                }
            });

            allSpaces = sessions.map(function(session) {
                return {
                    sessionId: session.id,
                    windowId: session.windowId,
                    name: session.name,
                    tabs: session.tabs,
                    history: session.history,
                    lastAccess: session.lastAccess,
                    tabGroups: session.tabGroups || [], // Include tab groups
                };
            });

            //sort results
            allSpaces.sort(spaceDateCompare);

            if (debug) console.log('[SW] Returning', allSpaces.length, 'cached spaces with windowIds:', 
                allSpaces.map(s => ({ sessionId: s.sessionId, name: s.name, windowId: s.windowId })));

            callback(allSpaces);
        });
    }

    function spaceDateCompare(a, b) {
        //order open sessions first
        if (a.windowId && !b.windowId) {
            return -1;
        } else if (!a.windowId && b.windowId) {
            return 1;

            //then order by last access date
        } else if (a.lastAccess > b.lastAccess) {
            return -1;
        } else if (a.lastAccess < b.lastAccess) {
            return 1;
        } else {
            return 0;
        }
    }

    function handleLoadSession(sessionId, tabUrl) {
        var session = spacesService.getSessionBySessionId(sessionId),
            pinnedTabId,
            urls,
            match;

        //if space is already open, then give it focus
        if (session.windowId) {
            handleLoadWindow(session.windowId, tabUrl);

            //else load space in new window
        } else {
            urls = session.tabs.map(function(curTab) {
                return curTab.url;
            });
            console.log('[SW] Creating maximized window for session:', session.name, 'with', urls.length, 'tabs');
            chrome.windows.create(
                {
                    url: urls,
                    state: 'maximized'
                },
                function(newWindow) {
                    console.log('[SW] Maximized window created with ID:', newWindow.id, 'state:', newWindow.state);
                    console.log('[SW] Session before matching - ID:', session.id, 'windowId:', session.windowId);
                    //force match this new window to the session
                    spacesService.matchSessionToWindow(session, newWindow);
                    console.log('[SW] Session after matching - ID:', session.id, 'windowId:', session.windowId);
                    
                    // Force update of spaces window to refresh the data with new windowId
                    setTimeout(function() {
                        console.log('[SW] Forcing spaces window update after session matching');
                        updateSpacesWindow('session.matched.to.window');
                    }, 1000); // Small delay to ensure everything is settled

                    //after window has loaded try to pin any previously pinned tabs
                    session.tabs.forEach(function(curSessionTab) {
                        if (curSessionTab.pinned) {
                            pinnedTabId = false;
                            newWindow.tabs.some(function(curNewTab) {
                                if (curNewTab.url === curSessionTab.url) {
                                    pinnedTabId = curNewTab.id;
                                    return true;
                                }
                            });
                            if (pinnedTabId) {
                                chrome.tabs.update(pinnedTabId, {
                                    pinned: true,
                                });
                            }
                        }
                    });

                    // Recreate tab groups if they exist
                    if (session.tabGroups && session.tabGroups.length > 0) {
                        console.log('[SW] Recreating tab groups for session:', session.name);
                        recreateTabGroups(newWindow.id, newWindow.tabs, session.tabGroups, function() {
                            console.log('[SW] Tab groups recreation completed');
                            
                            //if tabUrl is defined, then focus this tab
                            if (tabUrl) {
                                focusOrLoadTabInWindow(newWindow, tabUrl);
                            }
                        });
                    } else {
                        //if tabUrl is defined, then focus this tab
                        if (tabUrl) {
                            focusOrLoadTabInWindow(newWindow, tabUrl);
                        }
                    }

                    /*session.tabs.forEach(function (curTab) {
                    chrome.tabs.create({windowId: newWindow.id, url: curTab.url, pinned: curTab.pinned, active: false});
                });

                chrome.tabs.query({windowId: newWindow.id, index: 0}, function (tabs) {
                    chrome.tabs.remove(tabs[0].id);
                });*/
                }
            );
        }
    }
    function handleLoadWindow(windowId, tabUrl) {
        //assume window is already open, give it focus
        if (windowId) {
            focusWindow(windowId);
        }

        //if tabUrl is defined, then focus this tab
        if (tabUrl) {
            chrome.windows.get(windowId, { populate: true }, function(window) {
                focusOrLoadTabInWindow(window, tabUrl);
            });
        }
    }

    function focusWindow(windowId) {
        chrome.windows.update(windowId, { focused: true });
    }

    function focusOrLoadTabInWindow(window, tabUrl) {
        var match;

        match = window.tabs.some(function(tab) {
            if (tab.url === tabUrl) {
                chrome.tabs.update(tab.id, { active: true });
                return true;
            }
        });
        if (!match) {
            chrome.tabs.create({ url: tabUrl });
        }
    }

    function handleSaveNewSession(windowId, sessionName, callback) {
        chrome.windows.get(windowId, { populate: true }, function(curWindow) {
            var existingSession = spacesService.getSessionByName(sessionName);

            //if session with same name already exist, then prompt to override the existing session
            if (existingSession) {
                if (!checkSessionOverwrite(existingSession)) {
                    callback(false);
                    return;

                    //if we choose to overwrite, delete the existing session
                } else {
                    handleDeleteSession(existingSession.id, true, noop);
                }
            }

            // Get tab groups for this window
            getTabGroupsForWindow(windowId, function(tabGroups) {
                console.log('[SW] Saving session with tab groups:', tabGroups);
                spacesService.saveNewSession(
                    sessionName,
                    curWindow.tabs,
                    curWindow.id,
                    tabGroups,
                    callback
                );
            });
            return;
        });
    }

    // Helper function to get tab groups for a window
    function getTabGroupsForWindow(windowId, callback) {
        chrome.tabGroups.query({ windowId: windowId }, function(groups) {
            if (chrome.runtime.lastError) {
                console.log('[SW] Error getting tab groups:', chrome.runtime.lastError.message);
                callback([]);
                return;
            }

            if (groups.length === 0) {
                console.log('[SW] No tab groups found for window:', windowId);
                callback([]);
                return;
            }

            // For each group, we need to know which tabs belong to it
            chrome.tabs.query({ windowId: windowId }, function(tabs) {
                if (chrome.runtime.lastError) {
                    console.log('[SW] Error getting tabs for window:', chrome.runtime.lastError.message);
                    callback([]);
                    return;
                }

                const groupsWithTabs = groups.map(group => {
                    const groupTabs = tabs.filter(tab => tab.groupId === group.id);
                    const groupInfo = {
                        originalId: group.id, // Keep track of original ID for debugging
                        title: group.title || '', // Ensure title is never undefined
                        color: group.color,
                        collapsed: group.collapsed,
                        tabUrls: groupTabs.map(tab => tab.url), // Save URLs for matching during restoration
                        tabIndices: groupTabs.map(tab => tab.index), // Save original indices for restoration
                        tabCount: groupTabs.length
                    };
                    
                    console.log('[SW] Processing group:', group.id, 'title:', group.title, 'tabs:', groupTabs.length);
                    return groupInfo;
                }).filter(group => group.tabCount > 0); // Only include groups that have tabs

                console.log('[SW] Found', groupsWithTabs.length, 'tab groups with tabs for window:', windowId);
                callback(groupsWithTabs);
            });
        });
    }

    // Function to handle tab group changes and update the session
    function handleTabGroupChange(windowId, source) {
        console.log('[SW] ========== HANDLING TAB GROUP CHANGE ==========');
        console.log('[SW] Handling tab group change for window:', windowId, 'source:', source);
        
        // Get the current session for this window
        const session = spacesService.getSessionByWindowId(windowId);
        if (!session) {
            console.log('[SW] ❌ No session found for window:', windowId, '- skipping tab group update');
            console.log('[SW] Available sessions:', spacesService.getAllSessions().map(s => ({ id: s.id, name: s.name, windowId: s.windowId })));
            return;
        }

        console.log('[SW] ✅ Found session:', session.id, 'name:', session.name);

        // Get current window data including tabs and groups
        chrome.windows.get(windowId, { populate: true }, function(window) {
            if (chrome.runtime.lastError) {
                console.log('[SW] Error getting window for tab group update:', chrome.runtime.lastError.message);
                return;
            }

            console.log('[SW] Current window has', window.tabs.length, 'tabs');

            // Get updated tab groups for this window
            getTabGroupsForWindow(windowId, function(tabGroups) {
                console.log('[SW] ✅ Retrieved', tabGroups.length, 'tab groups for update');
                console.log('[SW] Tab groups details:', JSON.stringify(tabGroups, null, 2));
                
                // Update the session with current tab groups
                session.tabGroups = tabGroups;
                session.tabs = window.tabs; // Also update tabs in case they changed
                // Note: lastAccess is only updated when window is actually focused, not during tab updates
                
                console.log('[SW] 📝 About to save session with updated data...');
                
                // Save the updated session
                spacesService.saveExistingSession(session.id, function() {
                    console.log('[SW] ✅ Session successfully updated with new tab groups and tabs');
                    updateSpacesWindow(source);
                });
            });
        });
    }

    // Helper function to recreate tab groups when loading a session
    function recreateTabGroups(windowId, tabs, savedGroups, callback) {
        if (!savedGroups || savedGroups.length === 0) {
            console.log('[SW] No tab groups to recreate');
            callback();
            return;
        }

        console.log('[SW] Recreating', savedGroups.length, 'tab groups for window:', windowId);
        
        let groupsProcessed = 0;
        const totalGroups = savedGroups.length;

        savedGroups.forEach(function(savedGroup, groupIndex) {
            console.log('[SW] Recreating group', groupIndex + 1, ':', savedGroup.title || 'Untitled', 'with', savedGroup.tabCount, 'tabs');
            
            // Find the new tab IDs that correspond to the saved group's tabs
            const newTabIds = [];
            
            // Method 1: Try to match by index first
            savedGroup.tabIndices.forEach(function(originalIndex) {
                if (tabs[originalIndex] && tabs[originalIndex].id) {
                    newTabIds.push(tabs[originalIndex].id);
                }
            });

            // Method 2: If index matching didn't work well, try URL matching as fallback
            if (newTabIds.length < savedGroup.tabCount && savedGroup.tabUrls) {
                console.log('[SW] Index matching incomplete, trying URL matching');
                savedGroup.tabUrls.forEach(function(url) {
                    const matchingTab = tabs.find(tab => tab.url === url && !newTabIds.includes(tab.id));
                    if (matchingTab) {
                        newTabIds.push(matchingTab.id);
                    }
                });
            }

            if (newTabIds.length > 0) {
                console.log('[SW] Creating tab group with', newTabIds.length, 'tabs:', newTabIds);
                
                // Create the tab group
                chrome.tabs.group({ tabIds: newTabIds }, function(groupId) {
                    if (chrome.runtime.lastError) {
                        console.log('[SW] Error creating tab group:', chrome.runtime.lastError.message);
                        groupsProcessed++;
                        if (groupsProcessed === totalGroups) callback();
                        return;
                    }

                    console.log('[SW] Successfully created tab group:', groupId);

                    // Update the group properties
                    const updateProps = {
                        title: savedGroup.title || '',
                        color: savedGroup.color,
                        collapsed: savedGroup.collapsed
                    };

                    chrome.tabGroups.update(groupId, updateProps, function() {
                        if (chrome.runtime.lastError) {
                            console.log('[SW] Error updating tab group properties:', chrome.runtime.lastError.message);
                        } else {
                            console.log('[SW] Updated tab group properties - Title:', updateProps.title, 'Color:', updateProps.color);
                        }
                        
                        groupsProcessed++;
                        if (groupsProcessed === totalGroups) {
                            console.log('[SW] All tab groups recreated successfully');
                            callback();
                        }
                    });
                });
            } else {
                console.log('[SW] No valid tabs found for group:', savedGroup.title || 'Untitled');
                groupsProcessed++;
                if (groupsProcessed === totalGroups) callback();
            }
        });
    }

    function handleRestoreFromBackup(spaces, callback) {
        var existingSession, performSave, triggerCallback;

        spaces.forEach(function(space, index, spacesArray) {
            existingSession = spacesService.getSessionByName(space.name);
            performSave = true;
            triggerCallback = index === spacesArray.length - 1;

            //if session with same name already exist, then prompt to override the existing session
            if (existingSession) {
                if (!checkSessionOverwrite(existingSession)) {
                    performSave = false;

                    //if we choose to overwrite, delete the existing session
                } else {
                    handleDeleteSession(existingSession.id, true, noop);
                }
            }

            if (performSave) {
                spacesService.saveNewSession(
                    space.name,
                    space.tabs,
                    false,
                    space.tabGroups || [], // Preserve tab groups if they exist in backup
                    function(savedSession) {
                        if (triggerCallback) callback(null);
                    }
                );
            } else if (triggerCallback) {
                callback(null);
            }
        });
    }

    function handleImportNewSession(urlList, callback) {
        var tempName = 'Imported space: ',
            tabList = [],
            count = 1;

        while (spacesService.getSessionByName(tempName + count)) {
            count++;
        }

        tempName = tempName + count;

        tabList = urlList.map(function(text) {
            return { url: text };
        });

        //save session to database (no tab groups for simple URL imports)
        spacesService.saveNewSession(tempName, tabList, false, [], callback);
    }

    function handleUpdateSessionName(sessionId, sessionName, callback) {
        //check to make sure session name doesn't already exist
        var existingSession = spacesService.getSessionByName(sessionName);

        //if session with same name already exist, then prompt to override the existing session
        if (existingSession && existingSession.id !== sessionId) {
            if (!checkSessionOverwrite(existingSession)) {
                callback(false);
                return;

                //if we choose to override, then delete the existing session
            } else {
                handleDeleteSession(existingSession.id, true, noop);
            }
        }
        spacesService.updateSessionName(sessionId, sessionName, callback);
        return;
    }

    function handleDeleteSession(sessionId, force, callback) {
        var session = spacesService.getSessionBySessionId(sessionId);
        if (!force && !checkSessionDelete(session)) {
            callback(false);
            return;
        } else {
            spacesService.deleteSession(sessionId, callback);
            return;
        }
    }

    function handleAddLinkToNewSession(url, sessionName, callback) {
        var session = spacesService.getSessionByName(sessionName),
            newTabs = [{ url: url }];

        //if we found a session matching this name then return as an error as we are
        //supposed to be creating a new session with this name
        if (session) {
            callback(false);
            return;

            //else create a new session with this name containing this url
        } else {
            spacesService.saveNewSession(sessionName, newTabs, false, [], callback);
            return;
        }
    }

    function handleMoveTabToNewSession(tabId, sessionName, callback) {
        requestTabDetail(tabId, function(tab) {
            var session = spacesService.getSessionByName(sessionName);

            //if we found a session matching this name then return as an error as we are
            //supposed to be creating a new session with this name
            if (session) {
                callback(false);
                return;

                //else create a new session with this name containing this tab
            } else {
                //remove tab from current window (should generate window events)
                chrome.tabs.remove(tab.id);

                //save session to database
                spacesService.saveNewSession(
                    sessionName,
                    [tab],
                    false,
                    [], // No tab groups for single moved tab
                    callback
                );
                return;
            }
        });
    }

    function handleAddLinkToSession(url, sessionId, callback) {
        var session = spacesService.getSessionBySessionId(sessionId),
            newTabs = [{ url: url }];

        //if we have not found a session matching this name then return as an error as we are
        //supposed to be adding the tab to an existing session
        if (!session) {
            callback(false);
            return;
        } else {
            //if session is currently open then add link directly
            if (session.windowId) {
                handleAddLinkToWindow(url, session.windowId, callback);
                return;

                //else add tab to saved session in database
            } else {
                //update session in db
                session.tabs = session.tabs.concat(newTabs);
                spacesService.updateSessionTabs(
                    session.id,
                    session.tabs,
                    callback
                );
                return;
            }
        }
    }

    function handleAddLinkToWindow(url, windowId, callback) {
        chrome.tabs.create({ windowId: windowId, url: url, active: false });

        //NOTE: this move does not seem to trigger any tab event listeners
        //so we need to update sessions manually
        spacesService.queueWindowEvent(windowId);

        callback(true);
    }

    function handleMoveTabToSession(tabId, sessionId, callback) {
        requestTabDetail(tabId, function(tab) {
            var session = spacesService.getSessionBySessionId(sessionId),
                newTabs = [tab];

            //if we have not found a session matching this name then return as an error as we are
            //supposed to be adding the tab to an existing session
            if (!session) {
                callback(false);
                return;
            } else {
                //if session is currently open then move it directly
                if (session.windowId) {
                    moveTabToWindow(tab, session.windowId, callback);
                    return;

                    //else add tab to saved session in database
                } else {
                    //remove tab from current window
                    chrome.tabs.remove(tab.id);

                    //update session in db
                    session.tabs = session.tabs.concat(newTabs);
                    spacesService.updateSessionTabs(
                        session.id,
                        session.tabs,
                        callback
                    );
                    return;
                }
            }
        });
    }

    function handleMoveTabToWindow(tabId, windowId, callback) {
        requestTabDetail(tabId, function(tab) {
            moveTabToWindow(tab, windowId, callback);
        });
    }
    function moveTabToWindow(tab, windowId, callback) {
        chrome.tabs.move(tab.id, { windowId: windowId, index: -1 });

        //NOTE: this move does not seem to trigger any tab event listeners
        //so we need to update sessions manually
        spacesService.queueWindowEvent(tab.windowId);
        spacesService.queueWindowEvent(windowId);

        callback(true);
    }

    // Initialize services - but only once per service worker lifecycle
    function initializeServiceWorker() {
        if (!isInitialized) {
            if (debug) console.log('[SW] Initializing service worker for the first time');
            spacesService.initialiseSpaces();
            spacesService.initialiseTabHistory();
            isInitialized = true;
            console.log('[SW] Spaces service worker initialized');
        } else {
            if (debug) console.log('[SW] Service worker already initialized, reinitializing sessions');
            reinitializeSessions();
        }
    }

    // Reinitialize sessions when service worker wakes up without clearing windowIds
    function reinitializeSessions() {
        if (debug) console.log('[SW] Reinitializing sessions after service worker restart');
        
        dbService.fetchAllSessions(function(sessions) {
            if (debug) console.log('[SW] Reloaded', sessions.length, 'sessions from database');
            
            // Don't clear windowIds! Just restore the sessions cache
            spacesService.sessions = sessions;
            
            // Validate that windows still exist and clear stale windowIds
            chrome.windows.getAll({ populate: true }, function(windows) {
                var windowIds = windows.map(w => w.id);
                var sessionsUpdated = false;
                
                spacesService.sessions.forEach(function(session) {
                    if (session.windowId && session.windowId !== false && !windowIds.includes(session.windowId)) {
                        if (debug) console.log('[SW] Window', session.windowId, 'no longer exists for session', session.id, '- clearing windowId');
                        session.windowId = false;
                        sessionsUpdated = true;
                        
                        // Save to database
                        spacesService.saveExistingSession(session.id, function() {
                            if (debug) console.log('[SW] Cleared stale windowId for session', session.id);
                        });
                    }
                });
                
                // After clearing stale windowIds, try to re-match windows to sessions
                // This is crucial for Chrome restart scenarios
                windows.forEach(function(curWindow) {
                    if (!spacesService.filterInternalWindows(curWindow)) {
                        spacesService.checkForSessionMatch(curWindow);
                    }
                });
                
                // Run aggressive matching to recover from Chrome restart scenarios
                spacesService.performAggressiveSessionMatching(windows);
                
                if (debug) console.log('[SW] Session reinitialization complete. Sessions:', 
                    spacesService.sessions.map(s => ({ id: s.id, name: s.name, windowId: s.windowId })));
            });
        });
    }

    // Add service worker startup listener for Manifest V3
    chrome.runtime.onStartup.addListener(function() {
        if (debug) console.log('[SW] Chrome startup detected');
        initializeServiceWorker();
    });

    // Initialize on first load and on message (in case service worker restarted)
    initializeServiceWorker();

    return {
        requestSpaceFromWindowId: requestSpaceFromWindowId,
        requestCurrentSpace: requestCurrentSpace,
        requestHotkeys: requestHotkeys,
        generatePopupParams: generatePopupParams,
    };
})();
