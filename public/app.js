document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('dropZone');
  const videoInput = document.getElementById('videoInput');
  const filePreview = document.getElementById('filePreview');
  const videoPreview = document.getElementById('videoPreview');
  const fileName = document.getElementById('fileName');
  const uploadForm = document.getElementById('uploadForm');
  const textForm = document.getElementById('textForm');
  const results = document.getElementById('results');
  const analysisContent = document.getElementById('analysisContent');
  const loading = document.getElementById('loading');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const framesPerSecondInput = document.getElementById('framesPerSecond');
  const maxFramesInput = document.getElementById('maxFrames');
  const estimatedCostEl = document.getElementById('estimatedCost');
  
  let videoDuration = 0;

  // Drag and drop handlers
  dropZone.addEventListener('click', () => videoInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  });

  videoInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  function handleFile(file) {
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file');
      return;
    }

    const url = URL.createObjectURL(file);
    videoPreview.src = url;
    fileName.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
    filePreview.classList.remove('hidden');
    analyzeBtn.disabled = false;
    
    // Get video duration for cost estimation
    videoPreview.onloadedmetadata = () => {
      videoDuration = videoPreview.duration;
      updateCostEstimate();
    };
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  
  function updateCostEstimate() {
    const fps = parseFloat(framesPerSecondInput.value) || 1;
    const maxFrames = parseInt(maxFramesInput.value) || 15;
    
    let estimatedFrames = Math.ceil(videoDuration * fps);
    if (estimatedFrames > maxFrames) estimatedFrames = maxFrames;
    if (estimatedFrames < 1) estimatedFrames = 1;
    
    // Cost: ~$0.002 per image (low detail) + ~$0.01 for text
    const cost = (estimatedFrames * 0.002) + 0.01;
    estimatedCostEl.textContent = `~$${cost.toFixed(3)} (${estimatedFrames} frames)`;
  }
  
  // Update cost estimate when options change
  framesPerSecondInput.addEventListener('input', updateCostEstimate);
  maxFramesInput.addEventListener('input', updateCostEstimate);

  // Upload form submission
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const file = videoInput.files[0];
    if (!file) {
      alert('Please select a video file');
      return;
    }

    const formData = new FormData();
    formData.append('video', file);
    formData.append('description', document.getElementById('description').value);
    formData.append('framesPerSecond', framesPerSecondInput.value);
    formData.append('maxFrames', maxFramesInput.value);

    await analyzePlay('/api/videos/upload', formData);
  });

  // Text form submission
  textForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const description = document.getElementById('playDescription').value.trim();
    if (!description) {
      alert('Please describe the play');
      return;
    }

    await analyzePlay('/api/videos/analyze', { description }, true);
  });

  async function analyzePlay(url, data, isJson = false) {
    showLoading(true);
    results.classList.add('hidden');

    try {
      const options = {
        method: 'POST'
      };

      if (isJson) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(data);
      } else {
        options.body = data;
      }

      const response = await fetch(url, options);
      const result = await response.json();

      if (result.success) {
        displayResults(result.analysis);
      } else {
        throw new Error(result.error || 'Analysis failed');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Failed to analyze play: ' + error.message);
    } finally {
      showLoading(false);
    }
  }

  function showLoading(show) {
    loading.classList.toggle('hidden', !show);
    document.querySelectorAll('button[type="submit"]').forEach(btn => {
      btn.disabled = show;
    });
  }

  function displayResults(analysis) {
    analysisContent.innerHTML = `
      <div class="analysis-section">
        <h3>🏐 Play Type</h3>
        <p>${analysis.playType}</p>
      </div>
      
      <div class="analysis-section">
        <h3>📍 Player Positioning</h3>
        <p>${analysis.playerPositions}</p>
      </div>
      
      <div class="analysis-section">
        <h3>⚡ Technical Feedback</h3>
        <ul>
          ${analysis.technicalFeedback.map(item => `<li>${item}</li>`).join('')}
        </ul>
      </div>
      
      <div class="analysis-section">
        <h3>🎯 Tactical Suggestions</h3>
        <ul>
          ${analysis.tacticalSuggestions.map(item => `<li>${item}</li>`).join('')}
        </ul>
      </div>
      
      <div class="analysis-section">
        <h3>🏋️ Recommended Drills</h3>
        <ul>
          ${analysis.drillRecommendations.map(item => `<li>${item}</li>`).join('')}
        </ul>
      </div>
      
      <div class="analysis-section">
        <h3>📝 Overall Assessment</h3>
        <p>${analysis.overallAssessment}</p>
      </div>
      
      ${analysis.framesAnalyzed ? `
      <div class="analysis-meta">
        <span>📊 Frames analyzed: ${analysis.framesAnalyzed}</span>
        ${analysis.estimatedCost ? `<span>💰 API cost: ${analysis.estimatedCost}</span>` : ''}
      </div>
      ` : ''}
    `;
    
    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth' });
  }
});
