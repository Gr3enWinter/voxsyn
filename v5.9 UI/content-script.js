/**********************************************
 * CONTENT-SCRIPT WITH FAVORITES, HISTORY, 
 * NO HOTKEYS FOR POPUP, HOTKEY (CTRL/CMD+D) FOR DICTATION,
 * AND "CLICK FAVS THEN PICK SECTION" FLOW
 **********************************************/

// ======================== CONFIGURATION ======================== //
// Removed direct references to OpenAI endpoint/key in content script.
// The background script handles the actual API call to avoid CORS issues.

// Basic list of sections — make sure these match the actual text in .NavPanelAnchorName elements
const sectionCommands = {
  "Reason for Visit/CC": "reason for visit/cc",
  "History of Present Illness": "history of present illness",
  "PFSH": "pfsh",
  "Discussion/Plan": "discussion plan",
  "Counseling": "counseling",
  "Health Concerns": "health concerns",
  "Goals Section": "goals section",
  "Reason for Referral": "reason for referral",
};

// Minimal dictionary for demonstration
const customReplacements = {
  "cabbage": "CABG",
  "eight fib": "AFib",
  "a fib": "AFib",
  "v tach": "VTach",
};

// ======================== STATE & STORAGE KEYS ======================== //
let isRecording = false;
let mediaRecorder;
let recordedChunks = [];
let currentSection = null;

// For Undo
let lastFieldInserted = null;
let lastOriginalText = "";
let lastInsertedText = "";

// For local storage
const LS_FAVORITES_KEY = "DictationFavorites";
const LS_HISTORY_KEY = "DictationHistory";

// ======================== STYLES (INJECTED CSS) ======================== //
const style = document.createElement('style');
style.textContent = `
  #floating-dictate-btn {
    position: fixed !important;
    bottom: 20px !important;
    right: 20px !important;
    background-color: #007bff !important;
    color: white !important;
    padding: 10px 15px !important;
    border: none !important;
    border-radius: 50px !important;
    cursor: pointer !important;
    font-size: 14px !important;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1) !important;
    z-index: 2147483647 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
  }
  #recording-spinner {
    border: 2px solid #f3f3f3;
    border-top: 2px solid white;
    border-radius: 50%;
    width: 14px;
    height: 14px;
    animation: spin 0.7s linear infinite;
    margin-left: 8px;
    display: none;
  }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

  #dictation-menu {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #fff;
    padding: 15px;
    border-radius: 8px;
    box-shadow: 0 4px 10px rgba(0,0,0,0.2);
    z-index: 2147483647;
    max-width: 320px;
    text-align: center;
  }
  #dictation-menu h3 { margin-bottom: 10px; }
  #dictation-menu button {
    display: block;
    width: 100%;
    margin: 5px 0;
    padding: 10px;
    border: none;
    border-radius: 5px;
    background: #007bff;
    color: #fff;
    cursor: pointer;
    font-size: 14px;
  }
  .btn-cancel {
    background: #ccc;
    color: #000;
  }
  .btn-undo {
    background: #dc3545;
    color: #fff;
  }

  /* For the favorites/history UI */
  .dictation-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid #ddd;
    margin: 10px 0;
    padding: 5px;
    background: #fafafa;
  }
  .dictation-list-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #fff;
    margin-bottom: 5px;
    padding: 5px;
  }
  .dictation-list-item button {
    width: auto;
    margin: 0 3px;
    background: #6c757d;
  }
  .dictation-list-item span {
    flex-grow: 1;
    margin: 0 5px;
    word-break: break-word;
  }
  .small-input {
    width: 100%;
    margin-bottom: 5px;
    box-sizing: border-box;
  }
`;
document.head.appendChild(style);

// ======================== LOCAL STORAGE HELPERS ======================== //
function loadFavorites() {
  const raw = localStorage.getItem(LS_FAVORITES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveFavorites(favs) {
  localStorage.setItem(LS_FAVORITES_KEY, JSON.stringify(favs));
}

function loadHistory() {
  const raw = localStorage.getItem(LS_HISTORY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveHistory(historyArray) {
  localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(historyArray));
}

// ======================== HELPER FUNCTION FOR NORMALIZATION ======================== //
function normalizeString(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ======================== DICTATION-RELATED FUNCTIONS ======================== //

function isDictationPage() {
  // Return true if the page has .NavPanelAnchorName elements, etc.
  // or any logic you have for detecting a "dictation" page
  return document.querySelector(".NavPanelAnchorName") !== null;
}

/**
 * findTargetField:
 * 1) Locate the .NavPanelAnchorName whose text matches sectionName.
 * 2) Start from that anchor's <tr>, then walk subsequent <tr> siblings
 *    to find a .NavPanel.NavPanelField.
 * 3) Return the first <textarea> or <input> found.
 */
function findTargetField(sectionName) {
  console.log("DEBUG: findTargetField called for sectionName:", sectionName);

  const anchorDivs = document.querySelectorAll(".NavPanelAnchorName");
  for (let div of anchorDivs) {
    const labelText = div.textContent.trim();
    console.log("DEBUG: checking anchor text:", labelText);

    // Compare normalized strings to allow for slight differences in formatting
    if (normalizeString(labelText) === normalizeString(sectionName)) {
      console.log("DEBUG: Found matching anchorDiv:", div);

      // 1) Get the row containing the anchor
      let rowElement = div.closest("tr");
      if (!rowElement) {
        console.warn("DEBUG: No <tr> found for anchor:", div);
        continue;
      }

      // 2) If the field isn't in this row, iterate subsequent rows
      let navPanelField = rowElement.querySelector(".NavPanel.NavPanelField");
      while (!navPanelField && (rowElement = rowElement.nextElementSibling)) {
        navPanelField = rowElement.querySelector(".NavPanel.NavPanelField");
      }

      if (!navPanelField) {
        console.warn("DEBUG: Could not find any .NavPanel.NavPanelField after anchor:", div);
        return null;
      }
      console.log("DEBUG: Found .NavPanel.NavPanelField:", navPanelField);

      // 3) Inside that field, look for a <textarea> first
      const textArea = navPanelField.querySelector("textarea.es-TextArea.es-TextAreaComposite-area");
      if (textArea) {
        console.log("DEBUG: Returning .es-TextArea.es-TextAreaComposite-area:", textArea);
        return textArea;
      }

      // 4) Fallback to <input>
      const inputElem = navPanelField.querySelector("input[type='text']");
      if (inputElem) {
        console.log("DEBUG: Returning input[type='text']:", inputElem);
        return inputElem;
      }

      console.warn("DEBUG: No recognized text field found in .NavPanel.NavPanelField for anchor:", div);
      return null;
    }
  }

  console.warn("DEBUG: No anchor matched sectionName:", sectionName);
  return null;
}

/** Minimal auto-punctuation. */
function autoPunctuate(text) {
  if (!text) return text;
  let parts = text.split(/(\.|\?|\!|\n)/).filter(t => t.trim().length > 0);
  let result = parts.map(s => {
    let trimmed = s.trim();
    if (!/[.?!]$/.test(trimmed)) {
      trimmed += ".";
    }
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  });
  return result.join(" ");
}

/** Replace medical words (cabbage->CABG, etc.). */
function applyCustomReplacements(text) {
  if (!text) return text;
  for (let [key, value] of Object.entries(customReplacements)) {
    const regex = new RegExp(`\\b${key}\\b`, "gi");
    text = text.replace(regex, value);
  }
  return text;
}

/** Append new text to the field instead of replacing it.
 *  This function now amends (appends) new transcribed text to the existing value.
 *  It also checks to avoid duplicate punctuation between the existing text and the new text.
 */
function setFieldValueAndDispatchEvents(field, newValue) {
  console.log("DEBUG: setFieldValueAndDispatchEvents called with:", newValue);

  lastFieldInserted = field;
  lastOriginalText = field.value || "";
  lastInsertedText = newValue;

  let currentText = field.value || "";
  // If there's already some text, ensure there's a space separator.
  if (currentText && !/\s$/.test(currentText)) {
    currentText += " ";
  }
  // If current text ends with a punctuation and new text starts with one, remove the extra.
  if (currentText.endsWith(".") && newValue.startsWith(".")) {
    newValue = newValue.slice(1).trim();
  }
  const combined = currentText + newValue;
  field.value = combined;
  field.focus();
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "A", bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keyup", { key: "A", bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.blur();
}

/** Undo last insertion. */
function undoLastInsertion() {
  if (!lastFieldInserted) {
    alert("No last insertion to undo.");
    return;
  }
  lastFieldInserted.value = lastOriginalText;
  lastFieldInserted.focus();
  lastFieldInserted.dispatchEvent(new Event("input", { bubbles: true }));
  lastFieldInserted.dispatchEvent(new Event("change", { bubbles: true }));
  lastFieldInserted.blur();

  lastFieldInserted = null;
  lastOriginalText = "";
  lastInsertedText = "";
  alert("Undo complete.");
}

/**
 * Instead of direct fetch, we send a message to the background script
 * which does the actual call to https://api.openai.com/v1/audio/transcriptions 
 * to avoid CORS issues.
 */
async function sendAudioToAPI(blob) {
  console.log("DEBUG: Sending message to background script for transcription...");
  return new Promise((resolve, reject) => {
    // browser.runtime or chrome.runtime depending on your extension environment
    browser.runtime.sendMessage({
      action: "transcribeAudio",
      audioBlob: blob
    }).then(response => {
      if (!response || !response.success) {
        reject(response ? response.error : "Unknown error");
      } else {
        resolve(response.text.trim());
      }
    }).catch(err => {
      reject(err);
    });
  });
}

// ======================== CREATE / INJECT THE FLOATING BUTTON ======================== //
function createDictateButton() {
  const button = document.createElement('button');
  button.id = 'floating-dictate-btn';
  button.innerHTML = '🎤 Start Dictation';

  const spinner = document.createElement('div');
  spinner.id = 'recording-spinner';
  button.appendChild(spinner);

  // Clicking the button toggles start/stop
  button.addEventListener('click', () => startStopRecording(button));

  document.body.appendChild(button);
  return button;
}

function injectFloatingDictateButton() {
  if (!isDictationPage()) {
    const btn = document.getElementById('floating-dictate-btn');
    if (btn) btn.remove();
    return;
  }
  if (!document.getElementById('floating-dictate-btn')) {
    createDictateButton();
  }
}

/**
 * If not recording, show the menu. If recording, stop.
 */
function startStopRecording(button) {
  if (!isRecording) {
    showDictationMenu(button);
  } else {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
    isRecording = false;
    button.textContent = "🎤 Start Dictation";
    button.style.backgroundColor = "#007bff";

    const spinner = document.getElementById('recording-spinner');
    if (spinner) spinner.style.display = "none";
  }
}

// We'll keep a reference to the menu so we can remove it on subsequent calls
let dictationMenu = null;

// ======================== MAIN MENU (SHOWS SECTIONS, FAVS, HISTORY, ETC.) ======================== //
function showDictationMenu(button) {
  // Remove any existing menu
  if (dictationMenu) {
    dictationMenu.remove();
    dictationMenu = null;
  }

  dictationMenu = document.createElement('div');
  dictationMenu.id = 'dictation-menu';

  const title = document.createElement('h3');
  title.innerText = "Dictation Menu";
  dictationMenu.appendChild(title);

  // Define our menu options (without hotkeys)
  const menuOptions = [
    { label: "Reason for Visit/CC", action: () => pickSection("reason for visit/cc", button) },
    { label: "History of Present Illness", action: () => pickSection("history of present illness", button) },
    { label: "PFSH", action: () => pickSection("pfsh", button) },
    { label: "Discussion/Plan", action: () => pickSection("discussion plan", button) },
    { label: "Counseling", action: () => pickSection("counseling", button) },
    { label: "Health Concerns", action: () => pickSection("health concerns", button) },
    { label: "Goals Section", action: () => pickSection("goals section", button) },
    { label: "Reason for Referral", action: () => pickSection("reason for referral", button) },
    { label: "Favorites", action: () => { closeMenu(); showFavoritesUI(); } },
    { label: "History", action: () => { closeMenu(); showHistoryUI(); } },
    { label: "Undo Last Insertion", action: () => { closeMenu(); undoLastInsertion(); } },
    { label: "Cancel", action: () => closeMenu() },
  ];

  // Helper to close the menu
  function closeMenu() {
    if (dictationMenu) {
      dictationMenu.remove();
      dictationMenu = null;
    }
  }

  // Create a button for each menu option (no hotkey labels)
  menuOptions.forEach(opt => {
    const btn = document.createElement('button');
    btn.innerText = opt.label;
    btn.addEventListener('click', opt.action);
    dictationMenu.appendChild(btn);
  });

  document.body.appendChild(dictationMenu);
}

/** Helper to pick a section, focus the field, and start recording. */
async function pickSection(sectionKey, button) {
  if (dictationMenu) {
    dictationMenu.remove();
    dictationMenu = null;
  }
  currentSection = sectionKey.toLowerCase();

  const field = findTargetField(currentSection);
  if (field) {
    console.log("DEBUG: pickSection found field:", field);
    field.focus();
  } else {
    console.warn("DEBUG: pickSection could not find field for:", sectionKey);
  }

  await beginRecording(button);
}

/** Start recording audio, handle the final result, etc. */
async function beginRecording(button) {
  console.log("DEBUG: beginRecording called...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm; codecs=opus" });
    recordedChunks = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log("DEBUG: mediaRecorder.onstop triggered, recordedChunks:", recordedChunks);
      if (recordedChunks.length === 0) {
        console.warn("DEBUG: No recorded chunks to process.");
        return;
      }

      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      let text;
      try {
        text = await sendAudioToAPI(blob);
        console.log("DEBUG: Transcribed text from background script:", text);
      } catch (err) {
        console.error("DEBUG: Error during transcription:", err);
        return;
      }

      text = autoPunctuate(text);
      text = applyCustomReplacements(text);
      console.log("DEBUG: Final text after punctuation/replacements:", text);

      // Append (amend) the transcribed text into the chosen section
      if (currentSection && text) {
        saveTranscriptionToHistory(text);
        const field = findTargetField(currentSection);
        if (!field) {
          console.warn("DEBUG: Could not find target field for currentSection:", currentSection);
        } else {
          setFieldValueAndDispatchEvents(field, text);
        }
      } else {
        console.warn("DEBUG: No currentSection or empty text", { currentSection, text });
      }
    };

    mediaRecorder.start();
    isRecording = true;
    button.textContent = "⏹️ Stop Dictation";
    button.style.backgroundColor = "#ff3b3b";

    const spinner = document.getElementById('recording-spinner');
    if (spinner) spinner.style.display = "inline-block";

  } catch (err) {
    console.error("DEBUG: Error accessing microphone:", err);
    alert("Could not start recording. Microphone access was denied or unavailable.");
  }
}

/** Save a transcription to local history, up to 50 items. */
function saveTranscriptionToHistory(text) {
  const historyArray = loadHistory();
  historyArray.unshift({
    text,
    timestamp: Date.now()
  });
  while (historyArray.length > 50) {
    historyArray.pop();
  }
  saveHistory(historyArray);
}

// ======================== SHOW FAVORITES + "INSERT THEN PICK SECTION" ======================== //
function showFavoritesUI() {
  if (dictationMenu) {
    dictationMenu.remove();
    dictationMenu = null;
  }
  dictationMenu = document.createElement('div');
  dictationMenu.id = "dictation-menu";

  const title = document.createElement('h3');
  title.innerText = "Favorites";
  dictationMenu.appendChild(title);

  // Container for the list
  const listDiv = document.createElement('div');
  listDiv.classList.add('dictation-list');
  dictationMenu.appendChild(listDiv);

  const favorites = loadFavorites();
  favorites.forEach((favItem, index) => {
    const itemDiv = document.createElement('div');
    itemDiv.classList.add('dictation-list-item');

    const textSpan = document.createElement('span');
    textSpan.innerText = favItem;
    itemDiv.appendChild(textSpan);

    // Insert button
    const insertBtn = document.createElement('button');
    insertBtn.innerText = "Insert";
    insertBtn.addEventListener('click', () => {
      pickSectionForInsertion(favItem);
      dictationMenu.remove();
      dictationMenu = null;
    });
    itemDiv.appendChild(insertBtn);

    // Rename button
    const renameBtn = document.createElement('button');
    renameBtn.innerText = "Rename";
    renameBtn.addEventListener('click', () => {
      const newText = prompt("Edit favorite text:", favItem);
      if (newText !== null && newText.trim()) {
        favorites[index] = newText.trim();
        saveFavorites(favorites);
        showFavoritesUI();
      }
    });
    itemDiv.appendChild(renameBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.innerText = "Delete";
    deleteBtn.style.background = "#dc3545";
    deleteBtn.addEventListener('click', () => {
      favorites.splice(index, 1);
      saveFavorites(favorites);
      showFavoritesUI();
    });
    itemDiv.appendChild(deleteBtn);

    listDiv.appendChild(itemDiv);
  });

  // Add new favorite
  const newFavInput = document.createElement('textarea');
  newFavInput.classList.add('small-input');
  newFavInput.rows = 3;
  newFavInput.placeholder = "Add new favorite text here...";
  dictationMenu.appendChild(newFavInput);

  const addFavBtn = document.createElement('button');
  addFavBtn.innerText = "Add to Favorites";
  addFavBtn.addEventListener('click', () => {
    const newVal = newFavInput.value.trim();
    if (newVal) {
      favorites.push(newVal);
      saveFavorites(favorites);
      showFavoritesUI();
    }
  });
  dictationMenu.appendChild(addFavBtn);

  // Close
  const closeBtn = document.createElement('button');
  closeBtn.innerText = "Close";
  closeBtn.classList.add('btn-cancel');
  closeBtn.addEventListener('click', () => {
    dictationMenu.remove();
    dictationMenu = null;
  });
  dictationMenu.appendChild(closeBtn);

  document.body.appendChild(dictationMenu);
}

/** Let the user pick a section for a block of text from Favorites or History. */
function pickSectionForInsertion(textToInsert) {
  const menu = document.createElement('div');
  menu.id = "dictation-menu";

  const title = document.createElement('h3');
  title.innerText = "Pick a Section";
  menu.appendChild(title);

  Object.keys(sectionCommands).forEach(sectionName => {
    const secBtn = document.createElement('button');
    secBtn.innerText = sectionName;
    secBtn.addEventListener('click', () => {
      const sectionKey = sectionCommands[sectionName];
      const field = findTargetField(sectionKey);
      if (!field) {
        alert("Could not find the text field for " + sectionName);
      } else {
        setFieldValueAndDispatchEvents(field, textToInsert);
      }
      menu.remove();
    });
    menu.appendChild(secBtn);
  });

  const closeBtn = document.createElement('button');
  closeBtn.innerText = "Cancel";
  closeBtn.classList.add('btn-cancel');
  closeBtn.addEventListener('click', () => {
    menu.remove();
  });
  menu.appendChild(closeBtn);

  document.body.appendChild(menu);
}

// ======================== HISTORY UI ======================== //
function showHistoryUI() {
  if (dictationMenu) {
    dictationMenu.remove();
    dictationMenu = null;
  }
  dictationMenu = document.createElement('div');
  dictationMenu.id = "dictation-menu";

  const title = document.createElement('h3');
  title.innerText = "Transcription History";
  dictationMenu.appendChild(title);

  const listDiv = document.createElement('div');
  listDiv.classList.add('dictation-list');
  dictationMenu.appendChild(listDiv);

  const historyArray = loadHistory();
  if (!historyArray.length) {
    const noItems = document.createElement('div');
    noItems.innerText = "No history yet.";
    listDiv.appendChild(noItems);
  } else {
    historyArray.forEach((item, index) => {
      const itemDiv = document.createElement('div');
      itemDiv.classList.add('dictation-list-item');

      const textSpan = document.createElement('span');
      textSpan.innerText = item.text;
      itemDiv.appendChild(textSpan);

      // Insert from history
      const insertBtn = document.createElement('button');
      insertBtn.innerText = "Insert";
      insertBtn.addEventListener('click', () => {
        pickSectionForInsertion(item.text);
        dictationMenu.remove();
        dictationMenu = null;
      });
      itemDiv.appendChild(insertBtn);

      listDiv.appendChild(itemDiv);
    });
  }

  // Clear History button
  const clearBtn = document.createElement('button');
  clearBtn.innerText = "Clear History";
  clearBtn.style.background = "#dc3545";
  clearBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to clear all history?")) {
      saveHistory([]);
      showHistoryUI();
    }
  });
  dictationMenu.appendChild(clearBtn);

  // Close
  const closeBtn = document.createElement('button');
  closeBtn.innerText = "Close";
  closeBtn.classList.add('btn-cancel');
  closeBtn.addEventListener('click', () => {
    dictationMenu.remove();
    dictationMenu = null;
  });
  dictationMenu.appendChild(closeBtn);

  document.body.appendChild(dictationMenu);
}

// ======================== HOTKEY (CTRL/CMD + D) FOR DICTATION ======================== //
document.addEventListener('keydown', (evt) => {
  // For Windows use Ctrl, for Mac use Meta (Command)
  if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'd') {
    evt.preventDefault(); // Prevent default browser behavior
    const button = document.getElementById('floating-dictate-btn');
    if (button) {
      startStopRecording(button);
    }
  }
});

// ======================== INITIALIZATION ======================== //
const observer = new MutationObserver(() => injectFloatingDictateButton());
observer.observe(document.body, { childList: true, subtree: true });

// If the document is already loaded, inject immediately.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectFloatingDictateButton);
} else {
  injectFloatingDictateButton();
}
