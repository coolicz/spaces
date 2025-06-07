/*global chrome, dbService, render, createTabHtml */

(function() {
    'use strict';
    var debug = false, // Set to true to enable debug console logs
        UNSAVED_SESSION = '<em>Unnamed window</em>',
        nodes = {},
        globalSelectedSpace,
        bannerState;

    //METHODS FOR RENDERING SIDENAV (spaces list)

    function renderSpacesList(spaces) {
        var spaceEl;

        nodes.openSpaces.innerHTML = '';
        nodes.closedSpaces.innerHTML = '';

        spaces.forEach(function(space) {
            spaceEl = renderSpaceListEl(space);
            if (space.windowId) {
                nodes.openSpaces.appendChild(spaceEl);
            } else {
                nodes.closedSpaces.appendChild(spaceEl);
            }
        });
    }

    function renderSpaceListEl(space) {
        var listEl, iconEl, linkEl, hash;

        listEl = document.createElement('li');
        linkEl = document.createElement('a');
        iconEl = document.createElement('span');

        if (debug) console.log('[Frontend] Rendering space:', space.name, 'sessionId:', space.sessionId, 'windowId:', space.windowId);

        // Always prefer sessionId for saved sessions, only use windowId for temporary sessions
        if (space.sessionId) {
            hash = '#sessionId=' + space.sessionId;
            if (debug) console.log('[Frontend] Using sessionId hash for saved session:', space.sessionId);
        } else if (space.windowId) {
            hash = '#windowId=' + space.windowId;
            if (debug) console.log('[Frontend] Using windowId hash for temporary session:', space.windowId);
        }
        linkEl.setAttribute('href', hash);

        if (space.name) {
            linkEl.innerHTML = space.name;
        } else {
            linkEl.innerHTML = UNSAVED_SESSION;
        }

        if (
            globalSelectedSpace &&
            ((space.windowId &&
                globalSelectedSpace.windowId === space.windowId) ||
                (space.sessionId &&
                    globalSelectedSpace.sessionId === space.sessionId))
        ) {
            linkEl.className = 'selected';
        }

        /*if (space && !space.windowId) {
            iconEl.className = 'icon fa fa-external-link';
            iconEl.setAttribute('title', 'Load this space');
        } else {
            iconEl.className = 'icon fa fa-arrow-circle-right';
            iconEl.setAttribute('title', 'Switch to this space');
        }
        listEl.appendChild(iconEl);

        //add event listener for each load/switch icon
        iconEl.addEventListener("click", function() {
            handleLoadSpace(space.sessionId, space.windowId);
        });*/

        listEl.appendChild(linkEl);
        return listEl;
    }

    //METHODS FOR RENDERING MAIN CONTENT (space detail)

    function renderSpaceDetail(space, editMode) {
        updateNameForm(space);
        toggleNameEditMode(editMode);
        updateButtons(space);
        renderTabs(space);
    }

    function updateNameForm(space) {
        if (space && space.name) {
            nodes.nameFormInput.value = space.name;
            nodes.nameFormDisplay.innerHTML = space.name;
        } else {
            nodes.nameFormInput.value = '';
            if (space) {
                nodes.nameFormDisplay.innerHTML = UNSAVED_SESSION;
            } else {
                nodes.nameFormDisplay.innerHTML = '';
            }
        }
    }

    function toggleNameEditMode(visible) {
        if (visible) {
            nodes.nameFormDisplay.style.display = 'none';
            nodes.nameFormInput.style.display = 'inline';
            nodes.nameFormInput.focus();
        } else {
            nodes.nameFormDisplay.style.display = 'inline';
            nodes.nameFormInput.style.display = 'none';
        }
    }

    function updateButtons(space) {
        var sessionId, windowId;

        sessionId = space && space.sessionId ? space.sessionId : false;
        windowId = space && space.windowId ? space.windowId : false;

        nodes.actionSwitch.style.display = windowId ? 'inline-block' : 'none';
        nodes.actionOpen.style.display =
            space && !windowId ? 'inline-block' : 'none';
        nodes.actionEdit.style.display =
            sessionId || windowId ? 'inline-block' : 'none';
        nodes.actionExport.style.display =
            sessionId || windowId ? 'inline-block' : 'none';
        nodes.actionDelete.style.display =
            !windowId && sessionId ? 'inline-block' : 'none';
    }

    function renderTabs(space) {
        nodes.activeTabs.innerHTML = '';
        nodes.historicalTabs.innerHTML = '';

        if (!space) {
            nodes.spaceDetailContainer.style.display = 'none';
        } else {
            nodes.spaceDetailContainer.style.display = 'block';

            // Debug: Log the space data
            if (debug) console.log('[Spaces] Rendering tabs for space:', space.name);
            if (debug) console.log('[Spaces] Space has', space.tabs?.length || 0, 'tabs');
            if (debug) console.log('[Spaces] Space has', space.tabGroups?.length || 0, 'tab groups:', space.tabGroups);

            // Render active tabs with tab groups organization
            renderTabsWithGroups(space.tabs, space.tabGroups || [], space, nodes.activeTabs);
            
            // Render historical tabs (no groups for history)
            if (space.history) {
                space.history.forEach(function(tab) {
                    nodes.historicalTabs.appendChild(
                        renderTabListEl(tab, space)
                    );
                });
            } else {
                //TODO: hide historical tabs section
            }
        }
    }

    function renderTabsWithGroups(tabs, tabGroups, space, container) {
        if (!tabGroups || tabGroups.length === 0) {
            // No groups - render tabs normally
            tabs.forEach(function(tab) {
                container.appendChild(renderTabListEl(tab, space));
            });
            return;
        }

        if (debug) console.log('Rendering tabs with groups:', tabGroups.length, 'groups,', tabs.length, 'tabs');

        var renderedGroups = {};
        var processedTabIndices = [];

        // Process tabs in their exact window order
        tabs.forEach(function(tab, tabIndex) {
            // Check if this tab belongs to any group
            var belongsToGroup = null;
            tabGroups.forEach(function(group) {
                if (belongsToGroup) return; // Already found a group for this tab

                // Check both index-based and URL-based matching
                var indexMatch = group.tabIndices && group.tabIndices.includes(tabIndex);
                var urlMatch = group.tabUrls && group.tabUrls.includes(tab.url);
                
                if (indexMatch || urlMatch) {
                    belongsToGroup = group;
                }
            });

            if (belongsToGroup && !renderedGroups[belongsToGroup.title]) {
                // This is the first tab we've encountered from this group - render the entire group now
                
                // Add group header
                var groupHeader = renderTabGroupHeader(belongsToGroup);
                container.appendChild(groupHeader);

                // Add all tabs for this group in the order they appear in the tabs array
                tabs.forEach(function(groupTab, groupTabIndex) {
                    if (processedTabIndices.includes(groupTabIndex)) return; // Already processed

                    var belongsToThisGroup = false;
                    
                    // Check if tab belongs to current group
                    var indexMatch = belongsToGroup.tabIndices && belongsToGroup.tabIndices.includes(groupTabIndex);
                    var urlMatch = belongsToGroup.tabUrls && belongsToGroup.tabUrls.includes(groupTab.url);
                    
                    if (indexMatch || urlMatch) {
                        belongsToThisGroup = true;
                    }

                    if (belongsToThisGroup) {
                        container.appendChild(renderTabListEl(groupTab, space, true)); // true = indented
                        processedTabIndices.push(groupTabIndex);
                    }
                });

                renderedGroups[belongsToGroup.title] = true;
                
            } else if (!belongsToGroup && !processedTabIndices.includes(tabIndex)) {
                // This is an ungrouped tab - render it immediately
                container.appendChild(renderTabListEl(tab, space, false)); // false = not indented
                processedTabIndices.push(tabIndex);
            }
            // If tab belongs to an already-rendered group, we skip it (it was already rendered)
        });
    }

    function renderTabGroupHeader(group) {
        var headerEl = document.createElement('li');
        var titleEl = document.createElement('div');
        
        headerEl.className = 'tab-group-header';
        titleEl.className = 'tab-group-title';
        
        // Use group title or fallback to "Untitled Group"
        var groupTitle = group.title && group.title.trim() !== '' ? group.title : 'Untitled Group';
        titleEl.innerHTML = groupTitle;
        
        // Add color indicator if available
        if (group.color) {
            var colorIndicator = document.createElement('span');
            colorIndicator.className = 'tab-group-color';
            colorIndicator.style.backgroundColor = getTabGroupColor(group.color);
            titleEl.appendChild(colorIndicator);
        }
        
        // Add collapsed indicator if group was collapsed
        if (group.collapsed) {
            var collapsedIndicator = document.createElement('span');
            collapsedIndicator.className = 'tab-group-collapsed';
            collapsedIndicator.innerHTML = ' (collapsed)';
            titleEl.appendChild(collapsedIndicator);
        }
        
        headerEl.appendChild(titleEl);
        return headerEl;
    }

    function getTabGroupColor(colorName) {
        // Map Chrome's tab group color names to actual colors
        var colorMap = {
            'grey': '#dadce0',
            'blue': '#8ab4f8',
            'red': '#f28b82',
            'yellow': '#fed065',
            'green': '#81c995',
            'pink': '#ff8bcb',
            'purple': '#c58af9',
            'cyan': '#78d9ec',
            'orange': '#fcad70'
        };
        return colorMap[colorName] || '#dadce0'; // Default to grey
    }

    function renderTabListEl(tab, space, indented) {
        var listEl, linkEl, faviconEl, faviconSrc;

        listEl = document.createElement('li');
        linkEl = document.createElement('a');
        faviconEl = document.createElement('img');

        // Add class for indentation if this tab is in a group
        if (indented) {
            listEl.className = 'tab-in-group';
        }

        //try to get best favicon url path
        if (tab.favIconUrl && tab.favIconUrl.indexOf('chrome://theme') < 0) {
            faviconSrc = tab.favIconUrl;
        } else {
            faviconSrc = 'chrome://favicon/' + tab.url;
        }
        faviconEl.setAttribute('src', faviconSrc);

        linkEl.innerHTML = tab.title ? tab.title : tab.url;
        linkEl.setAttribute('href', tab.url);
        linkEl.setAttribute('target', '_blank');

        //add event listener for each tab link
        linkEl.addEventListener('click', function(e) {
            e.preventDefault();
            handleLoadTab(space.sessionId, space.windowId, tab.url);
        });

        if (tab.duplicate) {
            linkEl.className = 'duplicate';
        }

        listEl.appendChild(faviconEl);
        listEl.appendChild(linkEl);
        return listEl;
    }

    function initialiseBanner(spaces) {
        var savedSpacesExist = false;

        savedSpacesExist = spaces.some(function(space) {
            if (space.name) return true;
        });

        if (!savedSpacesExist) {
            setBannerState(1);
        }
    }

    function setBannerState(state) {
        var lessonOneEl = document.getElementById('lessonOne'),
            lessonTwoEl = document.getElementById('lessonTwo');

        if (state !== bannerState) {
            bannerState = state;

            toggleBanner(false, function() {
                if (state > 0) {
                    nodes.banner.style.display = 'block';
                    if (state === 1) {
                        lessonOneEl.style.display = 'block';
                        lessonTwoEl.style.display = 'none';
                    } else if (state === 2) {
                        lessonOneEl.style.display = 'none';
                        lessonTwoEl.style.display = 'block';
                    }
                    toggleBanner(true);
                }
            });
        }
    }

    function toggleBanner(visible, callback) {
        setTimeout(function() {
            nodes.banner.className = visible ? ' ' : 'hidden';
            if (typeof callback === 'function') {
                setTimeout(function() {
                    callback();
                }, 200);
            }
        }, 100);
    }

    function toggleModal(visible) {
        nodes.modalBlocker.style.display = visible ? 'block' : 'none';
        nodes.modalContainer.style.display = visible ? 'block' : 'none';

        if (visible) {
            nodes.modalInput.value = '';
            nodes.modalInput.focus();
        }
    }

    //ACTION HANDLERS

    function handleLoadSpace(sessionId, windowId) {
        if (sessionId) {
            performLoadSession(sessionId, function(response) {
                reroute(sessionId, false, false);
            });
        } else if (windowId) {
            performLoadWindow(windowId, function(response) {
                reroute(false, windowId, false);
            });
        }
    }

    function handleLoadTab(sessionId, windowId, tabUrl) {
        var noop = function() {};

        if (sessionId) {
            performLoadTabInSession(sessionId, tabUrl, noop);
        } else if (windowId) {
            performLoadTabInWindow(windowId, tabUrl, noop);
        }
    }

    //if background page requests this page update, then assume we need to do a full page update
    function handleAutoUpdateRequest(spaces) {
        var matchingSpaces, selectedSpace;

        console.log('[Frontend] Received updateSpaces message with', spaces.length, 'spaces');
        
        // Debug: Log the windowId values in received spaces
        console.log('[Frontend] Received spaces windowIds:', spaces.map(space => ({
            sessionId: space.sessionId,
            name: space.name,
            windowId: space.windowId
        })));

        //re-render main spaces list
        updateSpacesList(spaces);

        //if we are currently viewing a space detail then update this object from returned spaces list
        if (globalSelectedSpace) {
            console.log('[Frontend] Current globalSelectedSpace:', {
                sessionId: globalSelectedSpace.sessionId,
                windowId: globalSelectedSpace.windowId,
                name: globalSelectedSpace.name
            });

            //look for currently selected space by sessionId
            if (globalSelectedSpace.sessionId) {
                console.log('[Frontend] Looking for space with sessionId:', globalSelectedSpace.sessionId);
                matchingSpaces = spaces.filter(function(curSpace) {
                    return curSpace.sessionId === globalSelectedSpace.sessionId;
                });
                console.log('[Frontend] Found', matchingSpaces.length, 'matching spaces');
                
                if (matchingSpaces.length === 1) {
                    selectedSpace = matchingSpaces[0];
                    console.log('[Frontend] Found matching space by sessionId:', {
                        sessionId: selectedSpace.sessionId,
                        windowId: selectedSpace.windowId,
                        name: selectedSpace.name,
                        tabsCount: selectedSpace.tabs ? selectedSpace.tabs.length : 'undefined'
                    });
                }

                //else look for currently selected space by windowId
            } else if (globalSelectedSpace.windowId && !isNaN(globalSelectedSpace.windowId)) {
                console.log('[Frontend] Looking for space with windowId:', globalSelectedSpace.windowId);
                matchingSpaces = spaces.filter(function(curSpace) {
                    return curSpace.windowId === globalSelectedSpace.windowId;
                });
                if (matchingSpaces.length === 1) {
                    selectedSpace = matchingSpaces[0];
                    console.log('[Frontend] Found matching space by windowId:', {
                        sessionId: selectedSpace.sessionId,
                        windowId: selectedSpace.windowId
                    });
                }
            }

            //update cache and re-render space detail view
            if (selectedSpace) {
                console.log('[Frontend] Updating globalSelectedSpace from:', globalSelectedSpace.windowId, 'to:', selectedSpace.windowId);
                globalSelectedSpace = selectedSpace;
                console.log('[Frontend] globalSelectedSpace after update:', {
                    sessionId: globalSelectedSpace.sessionId,
                    windowId: globalSelectedSpace.windowId
                });
                updateSpaceDetail(true);
            } else {
                console.log('[Frontend] No matching space found, forcing fresh fetch');
                // Force a fresh fetch from the backend instead of using cached data
                updateSpaceDetail(false);
            }
        }
    }

    function handleNameSave() {
        var newName, oldName, sessionId, windowId;

        newName = nodes.nameFormInput.value;
        oldName = globalSelectedSpace.name;
        sessionId = globalSelectedSpace.sessionId;
        windowId = globalSelectedSpace.windowId;

        //if invalid name set then revert back to non-edit mode
        if (newName === oldName || newName.trim() === '') {
            updateNameForm(globalSelectedSpace);
            toggleNameEditMode(false);
            return;
        }

        //otherwise call the save service
        if (sessionId) {
            performSessionUpdate(newName, sessionId, function(session) {
                if (session) reroute(session.id, false, true);
            });
        } else if (windowId) {
            performNewSessionSave(newName, windowId, function(session) {
                if (session) reroute(session.id, false, true);
            });
        }

        //handle banner
        if (bannerState === 1) {
            setBannerState(2);
        }
    }

    function handleDelete() {
        var sessionId = globalSelectedSpace.sessionId;

        if (sessionId) {
            performDelete(sessionId, function() {
                updateSpacesList();
                reroute(false, false, true);
            });
        }
    }

    //import accepts either a newline separated list of urls or a json backup object
    function handleImport() {
        var rawInput, urlList, spacesObject;

        rawInput = nodes.modalInput.value;

        //check for json object
        try {
            spacesObject = JSON.parse(rawInput);
            performRestoreFromBackup(spacesObject, function() {
                updateSpacesList();
            });
        } catch (e) {
            //otherwise treat as a list of newline separated urls
            if (rawInput.trim().length > 0) {
                urlList = rawInput.split('\n');

                //filter out bad urls
                urlList = urlList.filter(function(url) {
                    if (url.trim().length > 0 && url.indexOf('://') > 0)
                        return true;
                    return false;
                });

                if (urlList.length > 0) {
                    performSessionImport(urlList, function(session) {
                        if (session) reroute(session.id, false, true);
                    });
                }
            }
        }
    }

    function handleBackup() {
        var leanSpaces, leanTabs, filename, blob, blobUrl, link;

        leanSpaces = [];

        fetchAllSpaces(function(spaces) {
            //strip out unnessary content from each space
            spaces.forEach(function(space) {
                leanTabs = [];
                space.tabs.forEach(function(curTab) {
                    leanTabs.push({
                        title: curTab.title,
                        url: normaliseTabUrl(curTab.url),
                        favIconUrl: curTab.favIconUrl,
                    });
                });

                var leanSpace = {
                    name: space.name,
                    tabs: leanTabs,
                };

                // Include tab groups if they exist
                if (space.tabGroups && space.tabGroups.length > 0) {
                    leanSpace.tabGroups = space.tabGroups.map(function(group) {
                        return {
                            title: group.title,
                            color: group.color,
                            collapsed: group.collapsed,
                            tabUrls: group.tabUrls,
                            tabIndices: group.tabIndices,
                            tabCount: group.tabCount
                        };
                    });
                }

                leanSpaces.push(leanSpace);
            });

            blob = new Blob([JSON.stringify(leanSpaces)], {
                type: 'application/json',
            });
            blobUrl = URL.createObjectURL(blob);
            filename = 'spaces-backup.json';
            link = document.createElement('a');
            link.setAttribute('href', blobUrl);
            link.setAttribute('download', filename);
            link.click();
        });
    }

    function handleExport() {
        var sessionId,
            windowId,
            csvContent,
            dataString,
            url,
            filename,
            blob,
            blobUrl,
            link;

        sessionId = globalSelectedSpace.sessionId;
        windowId = globalSelectedSpace.windowId;
        csvContent = '';
        dataString = '';

        fetchSpaceDetail(sessionId, windowId, function(space) {
            // Check if space has tab groups
            if (space.tabGroups && space.tabGroups.length > 0) {
                // Export with tab group information as comments
                dataString += '# Space: ' + (space.name || 'Untitled') + '\n';
                dataString += '# Contains ' + space.tabGroups.length + ' tab groups\n';
                dataString += '# Tab groups will be lost when importing this as plain text\n';
                dataString += '# Use "Backup" feature to preserve tab groups\n\n';
                
                space.tabGroups.forEach(function(group) {
                    dataString += '# Tab Group: ' + (group.title || 'Untitled Group') + ' (' + group.tabCount + ' tabs)\n';
                    
                    // Add tabs for this group
                    if (group.tabUrls) {
                        group.tabUrls.forEach(function(tabUrl) {
                            dataString += normaliseTabUrl(tabUrl) + '\n';
                        });
                    }
                    dataString += '\n';
                });
                
                // Add ungrouped tabs
                var groupedUrls = [];
                space.tabGroups.forEach(function(group) {
                    if (group.tabUrls) {
                        groupedUrls = groupedUrls.concat(group.tabUrls);
                    }
                });
                
                var ungroupedTabs = space.tabs.filter(function(tab) {
                    return !groupedUrls.includes(tab.url);
                });
                
                if (ungroupedTabs.length > 0) {
                    dataString += '# Ungrouped Tabs (' + ungroupedTabs.length + ' tabs)\n';
                    ungroupedTabs.forEach(function(tab) {
                        dataString += normaliseTabUrl(tab.url) + '\n';
                    });
                }
                
            } else {
                // Original behavior for spaces without groups
                space.tabs.forEach(function(curTab, tabIndex) {
                    url = normaliseTabUrl(curTab.url);
                    dataString += url + '\n';
                });
            }
            
            csvContent += dataString;

            blob = new Blob([csvContent], { type: 'text/plain' });
            blobUrl = URL.createObjectURL(blob);
            filename = (space.name || 'untitled') + '.txt';
            link = document.createElement('a');
            link.setAttribute('href', blobUrl);
            link.setAttribute('download', filename);
            link.click();
        });
    }

    function normaliseTabUrl(url) {
        if (url.indexOf('suspended.html') > 0 && url.indexOf('uri=') > 0) {
            url = url.substring(url.indexOf('uri=') + 4, url.length);
        }
        return url;
    }

    //SERVICES

    function fetchAllSpaces(callback) {
        chrome.runtime.sendMessage(
            {
                action: 'requestAllSpaces',
            },
            callback
        );
    }

    function fetchSpaceDetail(sessionId, windowId, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'requestSpaceDetail',
                sessionId: sessionId ? sessionId : false,
                windowId: windowId ? windowId : false,
            },
            callback
        );
    }

    function performLoadSession(sessionId, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'loadSession',
                sessionId: sessionId,
            },
            callback
        );
    }

    function performLoadWindow(windowId, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'loadWindow',
                windowId: windowId,
            },
            callback
        );
    }

    function performLoadTabInSession(sessionId, tabUrl, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'loadTabInSession',
                sessionId: sessionId,
                tabUrl: tabUrl,
            },
            callback
        );
    }

    function performLoadTabInWindow(windowId, tabUrl, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'loadTabInWindow',
                windowId: windowId,
                tabUrl: tabUrl,
            },
            callback
        );
    }

    function performDelete(sessionId, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'deleteSession',
                sessionId: sessionId,
            },
            callback
        );
    }

    function performSessionUpdate(newName, sessionId, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'updateSessionName',
                sessionName: newName,
                sessionId: sessionId,
            },
            callback
        );
    }

    function performNewSessionSave(newName, windowId, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'saveNewSession',
                sessionName: newName,
                windowId: windowId,
            },
            callback
        );
    }

    function performSessionImport(urlList, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'importNewSession',
                urlList: urlList,
            },
            callback
        );
    }

    function performRestoreFromBackup(spacesObject, callback) {
        chrome.runtime.sendMessage(
            {
                action: 'restoreFromBackup',
                spaces: spacesObject,
            },
            callback
        );
    }

    //EVENT LISTENERS FOR STATIC DOM ELEMENTS

    function addEventListeners() {
        //register hashchange listener
        window.onhashchange = function() {
            updateSpacesList();
            updateSpaceDetail();
        };

        //register incoming events listener
        chrome.runtime.onMessage.addListener(function(
            request,
            sender,
            callback
        ) {
            console.log('[Frontend] Received message:', request.action, 'Sender:', sender.id);
            
            if (request.action === 'updateSpaces' && request.spaces) {
                console.log('[Frontend] Processing updateSpaces message with', request.spaces.length, 'spaces');
                handleAutoUpdateRequest(request.spaces);
            } else {
                console.log('[Frontend] Ignoring message with action:', request.action);
            }
        });

        //register dom listeners
        nodes.nameFormDisplay.addEventListener('click', function() {
            toggleNameEditMode(true);
        });
        nodes.nameFormInput.addEventListener('blur', function() {
            handleNameSave();
        });
        nodes.nameForm.addEventListener('submit', function(e) {
            e.preventDefault();
            handleNameSave();
        });
        nodes.actionSwitch.addEventListener('click', function() {
            handleLoadSpace(
                globalSelectedSpace.sessionId,
                globalSelectedSpace.windowId
            );
        });
        nodes.actionOpen.addEventListener('click', function() {
            handleLoadSpace(globalSelectedSpace.sessionId, false);
        });
        nodes.actionEdit.addEventListener('click', function() {
            toggleNameEditMode(true);
        });
        nodes.actionExport.addEventListener('click', function() {
            handleExport();
        });
        nodes.actionBackup.addEventListener('click', function() {
            handleBackup();
        });
        nodes.actionDelete.addEventListener('click', function() {
            handleDelete();
        });
        nodes.actionImport.addEventListener('click', function(e) {
            e.preventDefault();
            toggleModal(true);
        });
        nodes.modalBlocker.addEventListener('click', function() {
            toggleModal(false);
        });
        nodes.modalButton.addEventListener('click', function() {
            handleImport();
            toggleModal(false);
        });
    }

    //ROUTING

    //update the hash with new ids (can trigger page re-render)
    function reroute(sessionId, windowId, forceRerender) {
        var hash;

        hash = '#';
        if (sessionId) {
            hash += 'sessionId=' + sessionId;
        } else if (windowId) {
            hash += 'windowId=' + sessionId;
        }

        //if hash hasn't changed page will not trigger onhashchange event
        if (window.location.hash === hash) {
            if (forceRerender) {
                updateSpacesList();
                updateSpaceDetail();
            }

            //otherwise set new hash and let the change listener call routeHash
        } else {
            window.location.hash = hash;
        }
    }

    function getVariableFromHash(key) {
        var hash, pairs, curKey, curVal, match;

        if (location.hash.length > 0) {
            hash = location.hash.substr(1, location.hash.length);
            pairs = hash.split('&');

            match = pairs.some(function(curPair) {
                curKey = curPair.split('=')[0];
                curVal = curPair.split('=')[1];
                if (curKey === key) return true;
            });

            if (match) {
                return curVal;
            }
        }
        return false;
    }

    function updateSpacesList(spaces) {
        //if spaces passed in then re-render immediately
        if (spaces) {
            renderSpacesList(spaces);

            //otherwise do a fetch of spaces first
        } else {
            fetchAllSpaces(function(newSpaces) {
                renderSpacesList(newSpaces);

                //determine if welcome banner should show
                initialiseBanner(newSpaces);
            });
        }
    }

    function updateSpaceDetail(useCachedSpace) {
        var sessionId, windowId, editMode;

        sessionId = getVariableFromHash('sessionId');
        windowId = getVariableFromHash('windowId');
        editMode = getVariableFromHash('editMode');

        //use cached currently selected space
        if (useCachedSpace) {
            addDuplicateMetadata(globalSelectedSpace);
            renderSpaceDetail(globalSelectedSpace, editMode);

            //otherwise refetch space based on hashvars
        } else if (sessionId || windowId) {
            fetchSpaceDetail(sessionId, windowId, function(space) {
                addDuplicateMetadata(space);

                //cache current selected space
                globalSelectedSpace = space;
                renderSpaceDetail(space, editMode);
            });

            //otherwise hide space detail view
        } else {
            //clear cache
            globalSelectedSpace = false;
            renderSpaceDetail(false, false);
        }
    }

    function addDuplicateMetadata(space) {
        var dupeCounts = {};

        space.tabs.forEach(function(tab) {
            tab.title = tab.title || tab.url;
            dupeCounts[tab.title] = dupeCounts[tab.title]
                ? dupeCounts[tab.title] + 1
                : 1;
        });
        space.tabs.forEach(function(tab) {
            tab.duplicate = dupeCounts[tab.title] > 1;
        });
    }

    window.onload = function() {
        var sessionId, windowId, editMode;

        //initialise global handles to key elements (singletons)
        nodes.home = document.getElementById('spacesHome');
        nodes.openSpaces = document.getElementById('openSpaces');
        nodes.closedSpaces = document.getElementById('closedSpaces');
        nodes.activeTabs = document.getElementById('activeTabs');
        nodes.historicalTabs = document.getElementById('historicalTabs');
        nodes.spaceDetailContainer = document.querySelector(
            '.content .contentBody'
        );
        nodes.nameForm = document.querySelector('#nameForm');
        nodes.nameFormDisplay = document.querySelector('#nameForm span');
        nodes.nameFormInput = document.querySelector('#nameForm input');
        nodes.actionSwitch = document.getElementById('actionSwitch');
        nodes.actionOpen = document.getElementById('actionOpen');
        nodes.actionEdit = document.getElementById('actionEdit');
        nodes.actionExport = document.getElementById('actionExport');
        nodes.actionBackup = document.getElementById('actionBackup');
        nodes.actionDelete = document.getElementById('actionDelete');
        nodes.actionImport = document.getElementById('actionImport');
        nodes.banner = document.getElementById('banner');
        nodes.modalBlocker = document.querySelector('.blocker');
        nodes.modalContainer = document.querySelector('.modal');
        nodes.modalInput = document.getElementById('importTextArea');
        nodes.modalButton = document.getElementById('importBtn');

        nodes.home.setAttribute('href', chrome.runtime.getURL('spaces.html'));

        //initialise event listeners for static elements
        addEventListeners();

        //render side nav
        updateSpacesList();

        //render main content
        updateSpaceDetail();
    };
})();
