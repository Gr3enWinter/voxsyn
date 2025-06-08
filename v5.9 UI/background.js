// background.js

// IMPORTANT: Store your API key here (securely if possible). 
// If you don't want to embed it in code, you might store it in an extension setting.
const OPENAI_API_KEY = "YOUROPENAIAPIKEY";

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "transcribeAudio") {
    // The request should contain a Blob or similar
    const formData = new FormData();
    formData.append("file", request.audioBlob, "audio.webm");
    formData.append("model", "whisper-1");

    fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: formData
    })
    .then(async resp => {
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(JSON.stringify(errJson));
      }
      return resp.json();
    })
    .then(data => {
      // Return the transcribed text
      sendResponse({ success: true, text: data.text });
    })
    .catch(err => {
      console.error("Error in background fetch:", err);
      sendResponse({ success: false, error: err.toString() });
    });

    // Indicate that we will send a response asynchronously
    return true;
  }
});
