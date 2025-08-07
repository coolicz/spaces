/*global chrome, localStorage */

/* spaces
 * Copyright (C) 2015 Dean Oemcke
 */

(function(globalContext) {
    'use strict';

    var spacesService = {
        tabHistoryUrlMap: {},
        closedWindowIds: {},
        sessions: [],
        sessionUpdateTimers: {},
        historyQueue: [],
        eventQueueCount: 0,
        lastVersion: 0,
        debug: true,

        noop: function() {},

        //initialise spaces - combine open windows with saved sessions
        initialiseSpaces: function() {
            var self = this,
                sessionId,
                match;

            console.log('[SpacesService] Initialising spaces...');

            //update version numbers
            this.lastVersion = this.fetchLastVersion();
            this.setLastVersion(chrome.runtime.getManifest().version);

            dbService.fetchAllSessions(function(sessions) {
                console.log('[SpacesService] Loaded', sessions.length, 'sessions from database');
                
                if (
                    chrome.runtime.getManifest().version === '0.18' &&
                    chrome.runtime.getManifest().version !== self.lastVersion
                ) {
                    self.resetAllSessionHashes(sessions);
                }

                chrome.windows.getAll({ populate: true }, function(windows) {
                    //populate session map from database
                    self.sessions = sessions;
                    
                    console.log('[SpacesService] Sessions loaded from database:', 
                        self.sessions.map(s => ({ id: s.id, name: s.name, windowId: s.windowId })));

                    //clear any previously saved windowIds only on first initialization
                    //This prevents losing window associations when service worker restarts
                    self.sessions.forEach(function(session) {
                        if (session.windowId) {
                            // Check if the window still exists before clearing
                            var windowExists = windows.some(function(window) {
                                return window.id === session.windowId;
                            });
                            
                            if (!windowExists) {
                                console.log('[SpacesService] Window', session.windowId, 'no longer exists for session', session.id);
                                session.windowId = false;
                            } else {
                                console.log('[SpacesService] Preserving existing windowId', session.windowId, 'for session', session.id);
                            }
                        }
                    });
                    
                    console.log('[SpacesService] Sessions after window validation:', 
                        self.sessions.map(s => ({ id: s.id, name: s.name, windowId: s.windowId })));

                    //then try to match current open windows with saved sessions
                    //use a more aggressive approach during initialization to handle Chrome restarts
                    windows.forEach(function(curWindow) {
                        if (!self.filterInternalWindows(curWindow)) {
                            self.checkForSessionMatch(curWindow);
                        }
                    });

                    // Additional pass: if we still have unmatched closed sessions after first pass,
                    // try fuzzy matching again with more relaxed criteria for Chrome restart scenarios
                    self.performAggressiveSessionMatching(windows);
                });
            });
        },

        // Aggressive session matching for Chrome restart scenarios
        performAggressiveSessionMatching: function(windows) {
            var self = this;
            
            // Find all unmatched closed sessions (sessions with no windowId)
            var unmatchedSessions = this.sessions.filter(function(session) {
                return session.id && !session.windowId && session.tabs && session.tabs.length > 0;
            });

            // Find all unmatched windows (windows with no named session)
            var unmatchedWindows = windows.filter(function(window) {
                if (self.filterInternalWindows(window)) {
                    return false;
                }
                var session = self.getSessionByWindowId(window.id);
                return !session || !session.id || !session.name;
            });

            if (unmatchedSessions.length === 0 || unmatchedWindows.length === 0) {
                if (this.debug) {
                    console.log('[SpacesService] Aggressive matching: no unmatched sessions or windows');
                }
                return;
            }

            if (this.debug) {
                console.log('[SpacesService] Starting aggressive session matching:');
                console.log('  - Unmatched sessions:', unmatchedSessions.length);
                console.log('  - Unmatched windows:', unmatchedWindows.length);
            }

            // Try to match unmatched windows to unmatched sessions with relaxed criteria
            unmatchedWindows.forEach(function(window) {
                var bestMatch = self.findFuzzySessionMatchRelaxed(window.tabs, unmatchedSessions);
                if (bestMatch) {
                    if (self.debug) {
                        console.log('[SpacesService] Aggressive match found - Session:', bestMatch.id, 
                            'Name:', bestMatch.name, 'Window:', window.id);
                    }
                    
                    // Remove any existing temporary session for this window
                    var existingSession = self.getSessionByWindowId(window.id);
                    if (existingSession && !existingSession.id) {
                        var index = self.sessions.indexOf(existingSession);
                        if (index !== -1) {
                            self.sessions.splice(index, 1);
                        }
                    }
                    
                    self.matchSessionToWindow(bestMatch, window);
                    
                    // Remove matched session from unmatched list
                    var sessionIndex = unmatchedSessions.indexOf(bestMatch);
                    if (sessionIndex !== -1) {
                        unmatchedSessions.splice(sessionIndex, 1);
                    }
                }
            });
        },

        // More relaxed fuzzy matching specifically for aggressive session recovery
        findFuzzySessionMatchRelaxed: function(currentTabs, candidateSessions) {
            var self = this;
            
            if (!candidateSessions || candidateSessions.length === 0) {
                return null;
            }

            // Extract meaningful URLs from current tabs
            var currentUrls = currentTabs.map(function(tab) {
                return self._cleanUrl(tab.url);
            }).filter(function(url) {
                return url && url.length > 0;
            });

            if (currentUrls.length === 0) {
                return null;
            }

            var bestMatch = null;
            var bestScore = 0;
            var relaxedThreshold = 0.5; // More relaxed 50% threshold for aggressive matching

            candidateSessions.forEach(function(session) {
                var sessionUrls = session.tabs.map(function(tab) {
                    return self._cleanUrl(tab.url);
                }).filter(function(url) {
                    return url && url.length > 0;
                });

                if (sessionUrls.length === 0) {
                    return;
                }

                // Calculate Jaccard similarity (intersection over union)
                var intersection = 0;
                var union = currentUrls.slice(); // copy current URLs

                currentUrls.forEach(function(currentUrl) {
                    if (sessionUrls.indexOf(currentUrl) !== -1) {
                        intersection++;
                    }
                });

                sessionUrls.forEach(function(sessionUrl) {
                    if (union.indexOf(sessionUrl) === -1) {
                        union.push(sessionUrl);
                    }
                });

                var jaccardScore = intersection / union.length;
                
                // Also calculate simple overlap score
                var overlapScore = intersection / Math.min(currentUrls.length, sessionUrls.length);
                
                // Use the better of the two scores
                var score = Math.max(jaccardScore, overlapScore);

                if (self.debug) {
                    console.log('[SpacesService] Relaxed fuzzy match candidate - Session:', session.id, 
                        'Jaccard:', jaccardScore.toFixed(2), 
                        'Overlap:', overlapScore.toFixed(2),
                        'Final Score:', score.toFixed(2),
                        'Intersection:', intersection);
                }

                if (score > bestScore && score >= relaxedThreshold) {
                    bestScore = score;
                    bestMatch = session;
                }
            });

            return bestMatch;
        },

        resetAllSessionHashes: function(sessions) {
            var self = this;

            sessions.forEach(function(session) {
                session.sessionHash = self.generateSessionHash(session.tabs);
                dbService.updateSession(session);
            });
        },

        //record each tab's id and url so we can add history items when tabs are removed
        initialiseTabHistory: function() {
            var self = this;
            chrome.tabs.query({}, function(tabs) {
                tabs.forEach(function(tab) {
                    self.tabHistoryUrlMap[tab.id] = tab.url;
                });
            });
        },

        //NOTE: if ever changing this funciton, then we'll need to update all
        //saved sessionHashes so that they match next time, using: resetAllSessionHashes()
        _cleanUrl: function(url) {
            if (!url) {
                return '';
            }

            //ignore urls from this extension
            if (url.indexOf(chrome.runtime.id) >= 0) {
                return '';
            }

            //ignore 'new tab' pages
            if (url.indexOf('chrome://newtab/') >= 0) {
                return '';
            }

            //add support for 'The Great Suspender'
            if (url.indexOf('suspended.html') > 0 && url.indexOf('uri=') > 0) {
                url = url.substring(url.indexOf('uri=') + 4, url.length);
            }

            //remove any text after a '#' symbol
            if (url.indexOf('#') > 0) {
                url = url.substring(0, url.indexOf('#'));
            }

            //remove any text after a '?' symbol
            if (url.indexOf('?') > 0) {
                url = url.substring(0, url.indexOf('?'));
            }

            return url;
        },

        generateSessionHash: function(tabs) {
            var self = this,
                text = tabs.reduce(function(prevStr, tab) {
                    return prevStr + self._cleanUrl(tab.url);
                }, '');

            var hash = 0,
                i,
                chr,
                len;
            if (text.length == 0) return hash;
            for (i = 0, len = text.length; i < len; i++) {
                chr = text.charCodeAt(i);
                hash = (hash << 5) - hash + chr;
                hash |= 0; // Convert to 32bit integer
            }
            return Math.abs(hash);
        },

        filterInternalWindows: function(curWindow) {
            //sanity check to make sure window isnt an internal spaces window
            if (
                curWindow.tabs.length === 1 &&
                curWindow.tabs[0].url.indexOf(chrome.runtime.id) >= 0
            ) {
                return true;
            }

            //also filter out popup or panel window types
            if (curWindow.type === 'popup' || curWindow.type === 'panel') {
                return true;
            }
            return false;
        },

        checkForSessionMatch: function(curWindow) {
            var sessionHash, temporarySession, matchingSession, fuzzyMatch;

            if (!curWindow.tabs || curWindow.tabs.length === 0) {
                return;
            }

            sessionHash = this.generateSessionHash(curWindow.tabs);
            temporarySession = this.getSessionByWindowId(curWindow.id);
            
            // First try exact hash match
            matchingSession = this.getSessionBySessionHash(sessionHash, true);
            
            // If no exact match, try fuzzy matching for Chrome restart scenarios
            if (!matchingSession) {
                fuzzyMatch = this.findFuzzySessionMatch(curWindow.tabs);
                if (fuzzyMatch) {
                    if (this.debug)
                        console.log(
                            'fuzzy matching session found: ' +
                                fuzzyMatch.id +
                                '. linking with window: ' +
                                curWindow.id
                        );
                    matchingSession = fuzzyMatch;
                }
            }

            if (matchingSession) {
                if (this.debug && !fuzzyMatch)
                    console.log(
                        'exact matching session found: ' +
                            matchingSession.id +
                            '. linking with window: ' +
                            curWindow.id
                    );

                this.matchSessionToWindow(matchingSession, curWindow);
            }

            //if no match found and this window does not already have a temporary session
            if (!matchingSession && !temporarySession) {
                if (this.debug)
                    console.log(
                        'no matching session found. creating temporary session for window: ' +
                            curWindow.id
                    );

                //create a new temporary session for this window (with no sessionId or name)
                this.createTemporaryUnmatchedSession(curWindow);
            }
        },

        // Fuzzy matching for Chrome restart scenarios where exact hash fails
        findFuzzySessionMatch: function(currentTabs) {
            var self = this;
            var candidateSessions = this.sessions.filter(function(session) {
                return session.id && !session.windowId && session.tabs && session.tabs.length > 0;
            });

            if (candidateSessions.length === 0) {
                return null;
            }

            // Extract meaningful URLs from current tabs (filter out chrome://newtab/, etc)
            var currentUrls = currentTabs.map(function(tab) {
                return self._cleanUrl(tab.url);
            }).filter(function(url) {
                return url && url.length > 0;
            });

            if (currentUrls.length === 0) {
                return null;
            }

            var bestMatch = null;
            var bestScore = 0;
            var minSimilarityThreshold = 0.7; // 70% of URLs must match

            candidateSessions.forEach(function(session) {
                var sessionUrls = session.tabs.map(function(tab) {
                    return self._cleanUrl(tab.url);
                }).filter(function(url) {
                    return url && url.length > 0;
                });

                if (sessionUrls.length === 0) {
                    return;
                }

                // Calculate similarity score
                var matchCount = 0;
                var totalUrls = Math.max(currentUrls.length, sessionUrls.length);

                currentUrls.forEach(function(currentUrl) {
                    if (sessionUrls.indexOf(currentUrl) !== -1) {
                        matchCount++;
                    }
                });

                var score = matchCount / totalUrls;

                if (self.debug) {
                    console.log('[SpacesService] Fuzzy match candidate - Session:', session.id, 
                        'Score:', score.toFixed(2), 
                        'Matches:', matchCount + '/' + totalUrls,
                        'Current URLs:', currentUrls.length,
                        'Session URLs:', sessionUrls.length);
                }

                // Require significant similarity and prefer sessions with exact tab count match
                if (score > bestScore && score >= minSimilarityThreshold) {
                    // Boost score if tab counts match exactly
                    if (currentUrls.length === sessionUrls.length) {
                        score *= 1.1;
                    }
                    
                    bestScore = score;
                    bestMatch = session;
                }
            });

            if (bestMatch && this.debug) {
                console.log('[SpacesService] Best fuzzy match found - Session:', bestMatch.id, 
                    'Name:', bestMatch.name, 'Score:', bestScore.toFixed(2));
            }

            return bestMatch;
        },

        matchSessionToWindow: function(session, curWindow) {
            var self = this;
            console.log('[SpacesService] Matching session to window - Session ID:', session.id, 'Window ID:', curWindow.id);
            
            //remove any other sessions tied to this windowId (temporary sessions)
            for (var i = this.sessions.length - 1; i >= 0; i--) {
                if (this.sessions[i].windowId === curWindow.id) {
                    if (this.sessions[i].id) {
                        this.sessions[i].windowId = false;
                    } else {
                        this.sessions.splice(i, 1);
                    }
                }
            }

            //assign windowId to newly matched session
            session.windowId = curWindow.id;
            // Note: lastAccess is only updated when window is actually focused, not during session matching
            
            console.log('[SpacesService] Session matched - Session ID:', session.id, 'New windowId:', session.windowId);
            
            // Debug: Check if session is actually in cache and updated
            var sessionInCache = this.getSessionBySessionId(session.id);
            if (sessionInCache) {
                console.log('[SpacesService] Session in cache has windowId:', sessionInCache.windowId);
            } else {
                console.log('[SpacesService] WARNING: Session not found in cache!');
            }
            
            // Save the session with the updated windowId if it's a saved session
            if (session.id) {
                console.log('[SpacesService] Saving session with updated windowId');
                this.saveExistingSession(session.id, function() {
                    console.log('[SpacesService] Session successfully saved with windowId:', session.windowId);
                    
                    // Debug: Check cache again after save
                    var sessionAfterSave = self.getSessionBySessionId(session.id);
                    if (sessionAfterSave) {
                        console.log('[SpacesService] After save - Session in cache has windowId:', sessionAfterSave.windowId);
                    }
                });
            }
        },

        createTemporaryUnmatchedSession: function(curWindow) {
            if (this.debug) {
                console.dir(this.sessions);
                console.dir(curWindow);
                console.log('couldnt match window. creating temporary session');
            }

            var sessionHash = this.generateSessionHash(curWindow.tabs);

            // Set lastAccess to an older time so temporary sessions don't automatically appear at top
            // They will only move to top when actually focused via handleWindowFocussed
            var initialTime = new Date();
            initialTime.setTime(initialTime.getTime() - (24 * 60 * 60 * 1000)); // 24 hours ago
            
            this.sessions.push({
                id: false,
                windowId: curWindow.id,
                sessionHash: sessionHash,
                name: false,
                tabs: curWindow.tabs,
                history: [],
                lastAccess: initialTime,
            });
        },

        //local storage getters/setters (using chrome.storage.local for service worker compatibility)
        fetchLastVersion: function() {
            // Return a default value for service worker compatibility
            // This will be improved with proper async storage later
            return 0;
        },

        setLastVersion: function(newVersion) {
            // Store version using chrome.storage.local for service worker compatibility
            try {
                chrome.storage.local.set({ 'spacesVersion': newVersion });
            } catch (e) {
                console.log('Failed to store version:', e);
            }
        },

        //event listener functions for window and tab events
        //(events are received and screened first in background.js)
        //-----------------------------------------------------------------------------------------

        handleTabRemoved: function(tabId, removeInfo, callback) {
            if (this.debug)
                console.log(
                    'handlingTabRemoved event. windowId: ' + removeInfo.windowId
                );

            //NOTE: isWindowClosing is true if the window cross was clicked causing the tab to be removed.
            //If the tab cross is clicked and it is the last tab in the window
            //isWindowClosing will still be false even though the window will close
            if (removeInfo.isWindowClosing) {
                //be very careful here as we definitley do not want these removals being saved
                //as part of the session (effectively corrupting the session)

                //should be handled by the window removed listener
                this.handleWindowRemoved(removeInfo.windowId, true, this.noop);

                //if this is a legitimate single tab removal from a window then update session/window
            } else {
                this.historyQueue.push({
                    url: this.tabHistoryUrlMap[tabId],
                    windowId: removeInfo.windowId,
                    action: 'add',
                });
                this.queueWindowEvent(
                    removeInfo.windowId,
                    this.eventQueueCount,
                    callback
                );

                //remove tab from tabHistoryUrlMap
                delete this.tabHistoryUrlMap[tabId];
            }
        },
        handleTabMoved: function(tabId, moveInfo, callback) {
            if (this.debug)
                console.log(
                    'handlingTabMoved event. windowId: ' + moveInfo.windowId
                );
            this.queueWindowEvent(
                moveInfo.windowId,
                this.eventQueueCount,
                callback
            );
        },
        handleTabUpdated: function(tab, changeInfo, callback) {
            //NOTE: only queue event when tab has completed loading (title property exists at this point)
            if (tab.status === 'complete') {
                if (this.debug)
                    console.log(
                        'handlingTabUpdated event. windowId: ' + tab.windowId
                    );

                //update tab history in case the tab url has changed
                this.tabHistoryUrlMap[tab.id] = tab.url;
                this.queueWindowEvent(
                    tab.windowId,
                    this.eventQueueCount,
                    callback
                );
            }

            //check for change in tab url. if so, update history
            if (changeInfo.url) {
                //add tab to history queue as an item to be removed (as it is open for this window)
                this.historyQueue.push({
                    url: changeInfo.url,
                    windowId: tab.windowId,
                    action: 'remove',
                });
            }
        },
        handleWindowRemoved: function(windowId, markAsClosed, callback) {
            var self = this,
                session;

            //ignore subsequent windowRemoved events for the same windowId (each closing tab will try to call this)
            if (this.closedWindowIds[windowId]) {
                callback();
            }

            if (this.debug)
                console.log(
                    'handlingWindowRemoved event. windowId: ' + windowId
                );

            //add windowId to closedWindowIds. the idea is that once a window is closed it can never be
            //rematched to a new session (hopefully these window ids never get legitimately re-used)
            if (markAsClosed) {
                if (this.debug)
                    console.log(
                        'adding window to closedWindowIds: ' + windowId
                    );
                this.closedWindowIds[windowId] = true;
                clearTimeout(this.sessionUpdateTimers[windowId]);
            }

            session = this.getSessionByWindowId(windowId);
            if (session) {
                //if this is a saved session then just remove the windowId reference
                if (session.id) {
                    console.log('[SpacesService] Window closed - clearing windowId for session:', session.id);
                    session.windowId = false;
                    session.lastAccess = new Date();
                    
                    // IMPORTANT: Save the session to database with windowId = false
                    this.saveExistingSession(session.id, function() {
                        console.log('[SpacesService] Session windowId cleared and saved to database');
                    });

                    //else if it is temporary session then remove the session from the cache
                } else {
                    this.sessions.some(function(session, index) {
                        if (session.windowId === windowId) {
                            self.sessions.splice(index, 1);
                            return true;
                        }
                    });
                }
            }

            callback();
        },
        handleWindowFocussed: function(windowId) {
            if (this.debug)
                console.log(
                    'handlingWindowFocussed event. windowId: ' + windowId
                );

            if (windowId <= 0) {
                return;
            }

            var session = this.getSessionByWindowId(windowId);
            if (session) {
                session.lastAccess = new Date();
                
                // Save the session to persist the lastAccess time for proper ordering
                if (session.id) {
                    this.saveExistingSession(session.id);
                }
            }
        },

        //1sec timer-based batching system.
        //Set a timeout so that multiple tabs all opened at once (like when restoring a session)
        //only trigger this function once (as per the timeout set by the last tab event)
        //This will cause multiple triggers if time between tab openings is longer than 1 sec
        queueWindowEvent: function(windowId, eventId, callback) {
            var self = this;

            clearTimeout(this.sessionUpdateTimers[windowId]);

            this.eventQueueCount++;

            this.sessionUpdateTimers[windowId] = setTimeout(function() {
                self.handleWindowEvent(windowId, eventId, callback);
            }, 1000);
        },

        //careful here as this function gets called A LOT
        handleWindowEvent: function(windowId, eventId, callback) {
            var self = this,
                historyItems,
                historyItem,
                session,
                i;

            callback = typeof callback !== 'function' ? this.noop : callback;

            if (this.debug)
                console.log('------------------------------------------------');
            if (this.debug)
                console.log(
                    'event: ' +
                        eventId +
                        '. attempting session update. windowId: ' +
                        windowId
                );

            //sanity check windowId
            if (!windowId || windowId <= 0) {
                if (this.debug)
                    console.log(
                        'received an event for windowId: ' +
                            windowId +
                            ' which is obviously wrong'
                    );
                return;
            }

            chrome.windows.get(windowId, { populate: true }, function(
                curWindow
            ) {
                if (chrome.runtime.lastError) {
                    console.log(
                        chrome.runtime.lastError.message +
                            '. perhaps its the development console???'
                    );

                    //if we can't find this window, then better remove references to it from the cached sessions
                    //don't mark as a removed window however, so that the space can be resynced up if the window
                    //does actually still exist (for some unknown reason)
                    self.handleWindowRemoved(windowId, false, self.noop);
                    return;
                }

                if (!curWindow || self.filterInternalWindows(curWindow)) {
                    return;
                }

                //don't allow event if it pertains to a closed window id
                if (self.closedWindowIds[windowId]) {
                    if (self.debug)
                        console.log(
                            'ignoring event as it pertains to a closed windowId: ' +
                                windowId
                        );
                    return;
                }

                //if window is associated with an open session then update session
                session = self.getSessionByWindowId(windowId);

                if (session) {
                    if (self.debug)
                        console.log(
                            'tab statuses: ' +
                                curWindow.tabs
                                    .map(function(curTab) {
                                        return curTab.status;
                                    })
                                    .join('|')
                        );

                    //look for tabs recently added/removed from this session and update session history
                    historyItems = self.historyQueue.filter(function(
                        historyItem
                    ) {
                        return historyItem.windowId === windowId;
                    });

                    for (i = historyItems.length - 1; i >= 0; i--) {
                        historyItem = historyItems[i];

                        if (historyItem.action === 'add') {
                            self.addUrlToSessionHistory(
                                session,
                                historyItem.url
                            );
                        } else if (historyItem.action === 'remove') {
                            self.removeUrlFromSessionHistory(
                                session,
                                historyItem.url
                            );
                        }
                        self.historyQueue.splice(i, 1);
                    }

                    //override session tabs with tabs from window
                    session.tabs = curWindow.tabs;
                    session.sessionHash = self.generateSessionHash(
                        session.tabs
                    );

                    //if it is a saved session then update db
                    if (session.id) {
                        self.saveExistingSession(session.id);
                    }
                }

                //if no session found, it must be a new window.
                //if session found without session.id then it must be a temporary session
                //check for sessionMatch
                if (!session || !session.id) {
                    if (self.debug) console.log('session check triggered');
                    self.checkForSessionMatch(curWindow);
                }
                callback();
            });
        },

        //PUBLIC FUNCTIONS

        getSessionBySessionId: function(sessionId) {
            var result = this.sessions.filter(function(session) {
                return session.id === sessionId;
            });
            return result.length === 1 ? result[0] : false;
        },
        getSessionByWindowId: function(windowId) {
            var result = this.sessions.filter(function(session) {
                return session.windowId === windowId;
            });
            return result.length === 1 ? result[0] : false;
        },
        getSessionBySessionHash: function(hash, closedOnly) {
            var result = this.sessions.filter(function(session) {
                if (closedOnly) {
                    return session.sessionHash === hash && !session.windowId;
                } else {
                    return session.sessionHash === hash;
                }
            });
            return result.length >= 1 ? result[0] : false;
        },
        getSessionByName: function(name) {
            var result = this.sessions.filter(function(session) {
                return (
                    session.name &&
                    session.name.toLowerCase() === name.toLowerCase()
                );
            });
            return result.length >= 1 ? result[0] : false;
        },
        getAllSessions: function() {
            return this.sessions;
        },

        addUrlToSessionHistory: function(session, newUrl) {
            if (this.debug) console.log('adding tab to history: ' + newUrl);

            var self = this,
                tabBeingRemoved;

            newUrl = this._cleanUrl(newUrl);

            if (newUrl.length === 0) {
                return false;
            }

            //don't add removed tab to history if there is still a tab open with same url
            //note: assumes tab has NOT already been removed from session.tabs
            tabBeingRemoved = session.tabs.filter(function(curTab) {
                return self._cleanUrl(curTab.url) === newUrl;
            });

            if (tabBeingRemoved.length !== 1) {
                return false;
            }

            if (!session.history) session.history = [];

            //see if tab already exists in history. if so then remove it (it will be re-added)
            session.history.some(function(historyTab, index) {
                if (self._cleanUrl(historyTab.url) === newUrl) {
                    session.history.splice(index, 1);
                    return true;
                }
            });

            //add url to session history
            session.history = tabBeingRemoved.concat(session.history);

            //trim history for this spae down to last 50 items
            session.history = session.history.slice(0, 50);

            return session;
        },

        removeUrlFromSessionHistory: function(session, newUrl) {
            if (this.debug) console.log('removing tab from history: ' + newUrl);

            var self = this;

            newUrl = this._cleanUrl(newUrl);

            if (newUrl.length === 0) {
                return;
            }

            //see if tab already exists in history. if so then remove it
            session.history.some(function(historyTab, index) {
                if (self._cleanUrl(historyTab.url) === newUrl) {
                    session.history.splice(index, 1);
                    return true;
                }
            });
        },

        //Database actions

        updateSessionTabs: function(sessionId, tabs, callback) {
            var session = this.getSessionBySessionId(sessionId);

            callback = typeof callback !== 'function' ? this.noop : callback;

            //update tabs in session
            session.tabs = tabs;
            session.sessionHash = this.generateSessionHash(session.tabs);

            this.saveExistingSession(session.id, callback);
        },

        updateSessionName: function(sessionId, sessionName, callback) {
            var session;

            callback = typeof callback !== 'function' ? this.noop : callback;

            session = this.getSessionBySessionId(sessionId);
            session.name = sessionName;

            this.saveExistingSession(session.id, callback);
        },

        saveExistingSession: function(sessionId, callback) {
            var self = this,
                session = this.getSessionBySessionId(sessionId),
                windowId = session.windowId;

            callback = typeof callback !== 'function' ? this.noop : callback;

            dbService.updateSession(session, callback);
        },

        saveNewSession: function(sessionName, tabs, windowId, tabGroups, callback) {
            var self = this,
                sessionHash = this.generateSessionHash(tabs),
                session;

            // Handle backward compatibility - tabGroups parameter is optional
            if (typeof tabGroups === 'function') {
                callback = tabGroups;
                tabGroups = [];
            }

            callback = typeof callback !== 'function' ? this.noop : callback;

            //check for a temporary session with this windowId
            if (windowId) {
                session = this.getSessionByWindowId(windowId);
            }

            //if no temporary session found with this windowId, then create one
            if (!session) {
                session = {
                    windowId: windowId,
                    history: [],
                };
                this.sessions.push(session);
            }

            //update temporary session details
            session.name = sessionName;
            session.sessionHash = sessionHash;
            session.tabs = tabs;
            session.tabGroups = tabGroups || []; // Add tab groups support
            session.lastAccess = new Date();

            console.log('[SpacesService] Saving session with tab groups:', tabGroups);

            //save session to db
            dbService.createSession(session, function(savedSession) {
                //update sessionId in cache
                //oddly, this seems to get updated without having to do this assignment
                //session.id = savedSession.id;

                callback(session);
            });
        },

        deleteSession: function(sessionId, callback) {
            var self = this;

            callback = typeof callback !== 'function' ? this.noop : callback;

            dbService.removeSession(sessionId, function() {
                //remove session from cached array
                self.sessions.some(function(session, index) {
                    if (session.id === sessionId) {
                        self.sessions.splice(index, 1);
                        return true;
                    }
                });
                callback();
            });
        },
    };
    globalContext.spacesService = spacesService;
})(typeof self !== 'undefined' ? self : window);
