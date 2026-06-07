import React, { useState, useEffect, useMemo } from 'react';
import { GitHubConfig, TranslationRow, GeminiModel, Project, GlobalState, GlobalSettings, ValueType, ViewMode, DiffRowState, Diff, DiffRow } from './types';
import { flattenObject, unflattenObject, saveToLocal, loadFromLocalCallback, downloadFile, importProjectFromText, compressText } from './utils';
import { GitHubService } from './services/githubService';
import { getTranslationSuggestions } from './services/geminiService';
import { Virtuoso } from 'react-virtuoso';

const STORAGE_KEY = 'multiverse_persistent_storage_v1';

interface AppProps {
  projectLoadQueue: Project[];
}

const App: React.FC<AppProps> = (props) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectLoadQueue, setProjectLoadQueue] = useState<Project[]>(props.projectLoadQueue);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [settings, setSettings] = useState<GlobalSettings>({ githubToken: '', geminiApiKey: '', suggestionChunkSize: 10 });
  const [loading, setLoading] = useState(false);
  const [rowAiLoading, setRowAiLoading] = useState<Record<string, boolean>>({});
  const [rowAiTemp, setRowAiTemp] = useState<Record<string, string>>({});
  const [searchTerms, setSearchTerms] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [showDialogSuggestAll, setShowDialogSuggestAll] = useState(false);
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [replaceExistAISuggestions, setReplaceExistAISuggestions] = useState(false);
  const [showSearchHelp, setShowSearchHelp] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.TRANSLATIONS);
  const [isConfirming, setIsConfirming] = useState(false);
  const [driftDiff, setDriftDiff] = useState<Diff | null>(null);
  const [viewingPast, setViewingPast] = useState<Record<string, boolean>>({});

  // Style mode toggles
  const [isSpreadsheetMode, setIsSpreadsheetMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('multiverse_ui_mode');
    if (saved) return saved === 'spreadsheet';
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('ui') === 'spreadsheet';
  });
  const [isSearchCollapsedMobile, setIsSearchCollapsedMobile] = useState(true);

  // Load from Browser Storage
  useEffect(() => {
    loadFromLocalCallback(STORAGE_KEY, (value) => {
      const saved = value as GlobalState;
      if (saved && saved.projects && saved.projects.length > 0) {
        setProjects(saved.projects);
        setActiveProjectId(saved.activeProjectId || saved.projects[0].id);
        setSettings(saved.settings || { githubToken: '', geminiApiKey: '', suggestionChunkSize: 10 });
      } else {
        const demo = createEmptyProject("Default Project");
        setProjects([demo]);
        setActiveProjectId(demo.id);
      }

      if (projectLoadQueue.length > 0) {
        setProjects(prev => [...prev, ...projectLoadQueue.filter(p => !prev.some(x => x.id === p.id))]);
        setActiveProjectId(projectLoadQueue[0].id);
        setProjects([]);
      }
    })
  }, []);

  // Save to Browser Storage on every state change
  useEffect(() => {
    if (projects.length > 0) {
      saveToLocal(STORAGE_KEY, { projects, activeProjectId, settings });
    }
  }, [projects, activeProjectId, settings]);

  // Persist style mode choice
  useEffect(() => {
    localStorage.setItem('multiverse_ui_mode', isSpreadsheetMode ? 'spreadsheet' : 'rounded');
  }, [isSpreadsheetMode]);

  useEffect(() => {
    setViewingPast({});
  }, [viewMode]);

  const activeProject = useMemo(() =>
    projects.find(p => p.id === activeProjectId) || null
    , [projects, activeProjectId]);

  const activeDiff: Diff = isConfirming ? driftDiff : (activeProject?.diffStack?.length ? activeProject.diffStack[activeProject.diffStack.length - 1] : { rows: [], originalFlatSource: {}, originalFlatTarget: {} });
  const keyDiffMap: Map<string, DiffRow> = activeDiff.rows.reduce((map, row) => {
    map.set(row.key, row);
    return map;
  }, new Map<string, DiffRow>());

  // Sync rename input with active project
  useEffect(() => {
    if (activeProject) setEditNameValue(activeProject.name);
  }, [activeProject?.id]);

  function createEmptyProject(name: string): Project {
    return {
      id: crypto.randomUUID(),
      name,
      config: { owner: '', repo: '', branch: 'main', sourcePath: '', targetPath: '' },
      rows: [],
      selectedModel: Object.values(GeminiModel)[0],
      lastUpdated: Date.now(),
      originalTargetData: {},
      note: '',
      diffStack: [],
    };
  }

  const handleCreateProject = () => {
    const name = prompt("Project Name:", "New Localization Project") || "New Project";
    const newProject = createEmptyProject(name);
    const updatedProjects = [...projects, newProject];
    setProjects(updatedProjects);
    setActiveProjectId(newProject.id);
    setShowConfig(true);
    setIsSidebarOpen(false);
  };

  const handleRenameProject = () => {
    if (!activeProject || !editNameValue.trim()) {
      setIsEditingName(false);
      return;
    }
    updateActiveProject({ name: editNameValue.trim() });
    setIsEditingName(false);
  };

  const handleDeleteProject = () => {
    if (!activeProject) return;
    if (!confirm(`Permanently remove project "${activeProject.name}"?`)) return;

    const remaining = projects.filter(p => p.id !== activeProject.id);

    if (remaining.length === 0) {
      const next = createEmptyProject("Default Project");
      setProjects([next]);
      setActiveProjectId(next.id);
    } else {
      setProjects(remaining);
      setActiveProjectId(remaining[0].id);
    }

    setShowConfig(false);
    setIsSidebarOpen(false);
  };

  const handleExportProject = () => {
    if (!activeProject) return;
    const jsonString = JSON.stringify(activeProject, null, 2);
    downloadFile(`${activeProject.name}.multiverse.json`, jsonString);
  };

  const handleImportProject = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const content = event.target?.result as string;
          const newProject = importProjectFromText(content);

          setProjects(prev => [...prev, newProject]);
          setActiveProjectId(newProject.id);
          alert(`Project "${newProject.name}" imported successfully!`);
        } catch (err: any) {
          alert(`Failed to import project: ${err.message}`);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleRevertProject = () => {
    if (!activeProject) return;
    if (!confirm(`Revert project "${activeProject.name}"? You will lose all changes.`)) return;

    updateActiveProject({ rows: activeProject.rows.map(r => ({ ...r, targetValue: r.originalTargetValue })) });
  };

  const updateActiveProject = (updates: Partial<Project>) => {
    setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, ...updates, lastUpdated: Date.now() } : p));
  };

  const confirmAllUnconfirmed = () => {
    if (!activeProject) return;
    if (!confirm(`Are you sure you want to confirm all unconfirmed translations?`)) return;
    const updatedRows = [...activeProject.rows];
    updatedRows.forEach(r => {
      if (r.sourceValue !== r.pastSourceValue) r.pastSourceValue = r.sourceValue;
    });
    updateActiveProject({ rows: updatedRows });
  };
  window["_MULTIVERSE_CONFIRM_ALL_UNCONFIRMED"] = confirmAllUnconfirmed;

  const handleFetchFiles = async () => {
    if (!activeProject?.config.owner || !activeProject?.config.repo || !activeProject?.config.sourcePath) {
      alert("⚠️ Configuration Incomplete\nPlease provide the Repository Owner, Name, and Source/Target paths in Project Settings.");
      setShowConfig(true);
      return;
    }

    setLoading(true);
    try {
      const service = new GitHubService(activeProject.config, null);
      const { source, target } = await service.loadFiles();

      const flatSource = flattenObject(source);
      const flatTarget = flattenObject(target);

      const diff: Diff = { rows: [], originalFlatSource: flatSource, originalFlatTarget: flatTarget };
      const currentRows = activeProject ? activeProject.rows : [];

      Object.keys(flatSource).forEach(key => {
        if (typeof flatSource[key] !== 'string') return;

        const sourceVal = flatSource[key].toString();
        const existingRow = currentRows.find(r => r.key === key);
        const targetValFromTarget = flatTarget[key] ? flatTarget[key].toString() : sourceVal;

        if (!existingRow) {
          diff.rows.push({
            key,
            sourceValue: '',
            updatedSourceValue: sourceVal,
            targetValue: targetValFromTarget,
            originalTargetValue: targetValFromTarget,
            pastSourceValue: '',
            state: DiffRowState.ADDED
          });
        } else if (existingRow.sourceValue !== sourceVal || existingRow.targetValue !== targetValFromTarget) {
          diff.rows.push({
            ...existingRow,
            updatedSourceValue: sourceVal,
            targetValue: existingRow.targetValue === existingRow.sourceValue
              ? targetValFromTarget
              : targetValFromTarget === sourceVal
                ? existingRow.targetValue
                : targetValFromTarget,
            originalTargetValue: targetValFromTarget,
            pastTargetValue: existingRow.targetValue,
            state: DiffRowState.MODIFIED
          });
        }
      });

      currentRows.forEach(row => {
        if (!(row.key in flatSource) || typeof flatSource[row.key] !== 'string') {
          diff.rows.push({
            ...row,
            updatedSourceValue: '',
            state: DiffRowState.REMOVED
          });
        }
      });

      setDriftDiff(diff);
      setIsConfirming(true);
      setViewMode(ViewMode.DIFFERENCES);
      updateActiveProject({ originalTargetData: target });
      setShowConfig(false);
    } catch (err: any) {
      alert(`GitHub Sync Failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleApplyDriftDiff = () => {
    if (!activeProject || !driftDiff) return;

    let newRows = [...activeProject.rows];

    driftDiff.rows.forEach(diffRow => {
      if (diffRow.state === DiffRowState.ADDED) {
        newRows.push({
          key: diffRow.key,
          sourceValue: diffRow.updatedSourceValue,
          targetValue: diffRow.targetValue,
          originalTargetValue: diffRow.originalTargetValue,
          pastSourceValue: diffRow.pastSourceValue,
          aiSuggestion: diffRow.aiSuggestion,
        });
      } else if (diffRow.state === DiffRowState.MODIFIED) {
        const index = newRows.findIndex(r => r.key === diffRow.key);
        if (index !== -1) {
          newRows[index] = {
            ...newRows[index],
            sourceValue: diffRow.updatedSourceValue,
            targetValue: newRows[index].targetValue === newRows[index].originalTargetValue ? diffRow.targetValue : newRows[index].targetValue,
            originalTargetValue: diffRow.originalTargetValue
          };
        }
      } /* else if (diffRow.state === DiffRowState.REMOVED) {
        newRows = newRows.filter(r => r.key !== diffRow.key);
      } */
    });

    const orderedKeys = Object.keys(driftDiff.originalFlatSource).filter(key => typeof driftDiff.originalFlatSource[key] === 'string');
    const rowMap = new Map(newRows.map(r => [r.key, r]));
    const orderedRows = orderedKeys.map(key => rowMap.get(key));

    const newDiffStack = [...(activeProject.diffStack || []), driftDiff];
    const missings = Object.keys(driftDiff.originalFlatSource).filter(key => typeof driftDiff.originalFlatSource[key] === 'string' && !(orderedRows.some(r => r.key === key)))

    if (missings.length > 0) {
      console.log(missings);
      console.log(orderedKeys);
      alert(`⚠️ Error: The set of keys has changed! Cannot apply drift diff. Missings(${missings.length}): ${missings.join(", ")}`);
      return;
    }

    updateActiveProject({ rows: orderedRows, diffStack: newDiffStack });
    setIsConfirming(false);
    setDriftDiff(null);
    setViewMode(ViewMode.TRANSLATIONS);
  };

  const handleClearDiffStack = () => {
    if (!activeProject) return;
    if (confirm("Clear all past difference history?")) {
      updateActiveProject({ diffStack: [] });
    }
  };

  const handleSuggestAll = async () => {
    if (!activeProject || activeProject.rows.length === 0) return;

    // Explicit API Key validation
    if (!settings.geminiApiKey) {
      alert("⚠️ Gemini API Key Missing\nYou need to provide a valid Gemini API Key in Settings to use AI suggestions.");
      setShowSettings(true);
      return;
    }

    try {
      const chunkSize = settings.suggestionChunkSize || 10;
      const updatedRows = [...filteredRows].filter(r => (replaceExistAISuggestions || (r.aiSuggestion === undefined || r.aiSuggestion === '')) && !rowAiLoading[r.key]);
      const newRows = [...activeProject.rows]

      let newRowLoading = { ...rowAiLoading };
      updatedRows.forEach(r => { newRowLoading[r.key] = true; });
      setRowAiLoading({ ...rowAiLoading, ...newRowLoading });

      for (let i = 0; i < updatedRows.length; i += chunkSize) {
        const chunk = updatedRows.slice(i, i + chunkSize);
        const sourceTexts = chunk.map(r => {
          return ({ key: r.key, value: r.sourceValue });
        });

        const combinedInstructions = [activeProject.note?.replace("\n", ", "), additionalInstructions].filter(Boolean).join(", ");
        const suggestions = await getTranslationSuggestions(
          activeProject.selectedModel, settings.geminiApiKey,
          activeProject.config.sourcePath.split('/').pop()?.replace('.json', '') || 'Source',
          activeProject.config.targetPath.split('/').pop()?.replace('.json', '') || 'Target',
          sourceTexts,
          combinedInstructions
        );
        chunk.forEach(r => { newRowLoading[r.key] = false; });

        Object.keys(suggestions).forEach(key => {
          const rowIndex = newRows.findIndex(r => r.key === key);
          if (rowIndex !== -1) newRows[rowIndex].aiSuggestion = suggestions[key];
        });
        Object.keys(suggestions).forEach(key => {
          setRowAiTemp({ ...rowAiTemp, [key]: suggestions[key] });
        });
      }
      setRowAiLoading({ ...rowAiLoading, ...newRowLoading });
      updateActiveProject({ rows: newRows });
      let updatedAiTemp = { ...rowAiTemp };
      updatedRows.forEach(r => { updatedAiTemp[r.key] = undefined; });
      setRowAiTemp(updatedAiTemp);
    } catch (err: any) {
      alert(`AI Engine Error: ${err.message}. Try re-authenticating your Gemini Key in Settings.`);
    } finally {
    }
  };

  const handlePushToGitHub = async () => {
    if (!settings.githubToken) {
      alert("⚠️ GitHub Token Missing\nYou need a Personal Access Token to push changes. Set it in Settings.");
      setShowSettings(true);
      return;
    }
    const commitMessage = prompt("Commit message:", `Update ${activeProject?.config.targetPath} translations`);
    if (!commitMessage || !activeProject) return;

    setLoading(true);
    try {
      const flatData: Record<string, string> = {};
      activeProject.rows.forEach(r => { flatData[r.key] = r.targetValue; });
      const content = JSON.stringify(unflattenObject(flatData), null, 4);

      const service = new GitHubService(activeProject.config, settings.githubToken);
      await service.pushFile(content, activeProject.config.targetPath, commitMessage);

      updateActiveProject({
        rows: activeProject.rows.map(r => ({ ...r, originalTargetValue: r.targetValue }))
      });
      alert(`Success! Changes pushed to GitHub.\nMessage: ${commitMessage}\nRepo/Branch: https://github.com/${activeProject.config.owner}/${activeProject.config.repo}/${activeProject.config.branch}`);
    } catch (err: any) {
      alert(`GitHub Push Failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRawJson = () => {
    if (!activeProject) return;
    const flatData: Record<string, string> = {};
    activeProject.rows.forEach(r => { flatData[r.key] = r.targetValue; });
    const jsonString = JSON.stringify(unflattenObject(flatData), null, 4);
    navigator.clipboard.writeText(jsonString);
    alert("Target JSON copied to clipboard!");
  };

  const handleCopyLink = () => {
    if (!activeProject) return;
    const jsonString = JSON.stringify(activeProject, null, 2)
    const url = window.location.origin + window.location.pathname + "?import=" + compressText(jsonString);
    if (url.length > 2000) {
      alert(`Project is too large to be shared via URL! Use Export Project as File instead. (${url.length})`);
      return;
    }
    navigator.clipboard.writeText(url);
    alert("Project URL copied to clipboard!");
  };

  const filteredRows = activeProject?.rows?.filter?.(r => {
    const dr = keyDiffMap.get(r.key);

    return searchTerms.toLowerCase().split("||").some((searchTerm) => {
      const queryWithoutTag = searchTerm.toLowerCase().substring(0, searchTerm.includes("#") ? searchTerm.indexOf("#") : searchTerm.length).trim();
      return ((!searchTerm.includes("#reg") ? (
        r.key.toLowerCase().includes(queryWithoutTag) ||
        (!searchTerm.includes("#key")) && (
          r.sourceValue.toLowerCase().includes(queryWithoutTag) ||
          r.targetValue.toLowerCase().includes(queryWithoutTag)))
        :
        (searchTerm.includes("#reg") && (
          new RegExp(queryWithoutTag).test(r.key.toLowerCase()) ||
          (!searchTerm.includes("#key")) && (
            new RegExp(queryWithoutTag).test(r.sourceValue.toLowerCase()) ||
            new RegExp(queryWithoutTag).test(r.targetValue.toLowerCase())))
        )) &&
        (
          ((!(searchTerm.includes("#dupdated") || searchTerm.includes("#dupd"))) || dr && (dr.pastTargetValue && dr.targetValue !== dr.pastTargetValue)) &&
          ((!(searchTerm.includes("#dchanged") || searchTerm.includes("#dcha"))) || dr && (dr.pastTargetValue && dr.targetValue !== dr.pastTargetValue && dr.pastSourceValue !== dr.sourceValue)) &&
          ((!(searchTerm.includes("#dtranslated") || searchTerm.includes("#dtra"))) || dr && (dr.pastTargetValue && dr.targetValue !== dr.pastTargetValue && dr.pastTargetValue === r.sourceValue)) &&
          ((!(searchTerm.includes("#dmodified") || searchTerm.includes("#dmod"))) || dr && dr.state === DiffRowState.MODIFIED) &&
          ((!(searchTerm.includes("#dadded") || searchTerm.includes("#dadd"))) || dr && dr.state === DiffRowState.ADDED) &&
          ((!(searchTerm.includes("#modified") || searchTerm.includes("#mod"))) || r.targetValue !== r.originalTargetValue) &&
          ((!(searchTerm.includes("#unconfirmed") || searchTerm.includes("#unc"))) || r.sourceValue !== r.pastSourceValue) &&
          ((!(searchTerm.includes("#done") || searchTerm.includes("#don"))) || r.sourceValue !== r.originalTargetValue && r.targetValue === r.originalTargetValue) &&
          ((!(searchTerm.includes("#undone") || searchTerm.includes("#und"))) || r.sourceValue === r.targetValue || !r.targetValue || r.targetValue == '') &&
          ((!(searchTerm.includes("#doing") || searchTerm.includes("#doi"))) || r.sourceValue === r.targetValue || !r.targetValue || r.targetValue == '' || r.targetValue !== r.originalTargetValue) &&
          ((!(searchTerm.includes("#ai") || searchTerm.includes("#ai"))) || (r.aiSuggestion && r.aiSuggestion !== '')) &&
          ((!(searchTerm.includes("#noai") || searchTerm.includes("#noa"))) || (!r.aiSuggestion || r.aiSuggestion === '' || !rowAiLoading[r.key])) &&
          ((!(searchTerm.includes("#empty") || searchTerm.includes("#emp"))) || (!r.targetValue || r.targetValue === '')) &&
          ((!(searchTerm.includes("#inarray") || searchTerm.includes("#ina"))) || (/^.*\.\d+$/).test(r.key)) &&
          ((!(searchTerm.includes("#aifetching") || searchTerm.includes("#aif"))) || (rowAiLoading[r.key] === true))
        )
      )
    })
  }) || [];

  const modifiedCount = activeProject?.rows.filter(r => r.targetValue !== r.originalTargetValue).length || 0;
  const unconfirmedCount = activeProject?.rows.filter(r => r.sourceValue !== r.pastSourceValue).length || 0;

  const filteredDiffRows = activeDiff.rows.filter(r =>
    searchTerms.toLowerCase().split("||").some((searchTerm) => {
      const queryWithoutTag = searchTerm.toLowerCase().substring(0, searchTerm.includes("#") ? searchTerm.indexOf("#") : searchTerm.length).trim();
      return ((!searchTerm.includes("#reg") ? (
        r.key.toLowerCase().includes(queryWithoutTag) ||
        (!searchTerm.includes("#key")) && (
          r.sourceValue.toLowerCase().includes(queryWithoutTag) ||
          r.targetValue.toLowerCase().includes(queryWithoutTag)))
        :
        (searchTerm.includes("#reg") && (
          new RegExp(queryWithoutTag).test(r.key.toLowerCase()) ||
          (!searchTerm.includes("#key")) && (
            new RegExp(queryWithoutTag).test(r.sourceValue.toLowerCase()) ||
            new RegExp(queryWithoutTag).test(r.targetValue.toLowerCase())))
        )) &&
        (
          ((!(searchTerm.includes("#dupdated") || searchTerm.includes("#dupd"))) || (r.pastTargetValue && r.targetValue !== r.pastTargetValue)) &&
          ((!(searchTerm.includes("#dtranslated") || searchTerm.includes("#dtra"))) || (r.pastTargetValue && r.targetValue !== r.pastTargetValue && r.pastTargetValue === r.sourceValue)) &&
          ((!(searchTerm.includes("#dmodified") || searchTerm.includes("#dmod"))) || r.state === DiffRowState.MODIFIED) &&
          ((!(searchTerm.includes("#dadded") || searchTerm.includes("#dadd"))) || r.state === DiffRowState.ADDED) &&
          ((!(searchTerm.includes("#dremoved") || searchTerm.includes("#drem"))) || r.state === DiffRowState.REMOVED) &&
          ((!(searchTerm.includes("#modified") || searchTerm.includes("#mod"))) || r.targetValue !== r.originalTargetValue) &&
          ((!(searchTerm.includes("#unconfirmed") || searchTerm.includes("#unc"))) || r.sourceValue !== r.pastSourceValue) &&
          ((!(searchTerm.includes("#done") || searchTerm.includes("#don"))) || r.sourceValue !== r.originalTargetValue && r.targetValue === r.originalTargetValue) &&
          ((!(searchTerm.includes("#undone") || searchTerm.includes("#und"))) || r.sourceValue === r.targetValue || !r.targetValue || r.targetValue == '') &&
          ((!(searchTerm.includes("#doing") || searchTerm.includes("#doi"))) || r.sourceValue === r.targetValue || !r.targetValue || r.targetValue == '' || r.targetValue !== r.originalTargetValue) &&
          ((!(searchTerm.includes("#ai") || searchTerm.includes("#ai"))) || (r.aiSuggestion && r.aiSuggestion !== '')) &&
          ((!(searchTerm.includes("#noai") || searchTerm.includes("#noa"))) || (!r.aiSuggestion || r.aiSuggestion === '' || !rowAiLoading[r.key])) &&
          ((!(searchTerm.includes("#empty") || searchTerm.includes("#emp"))) || (!r.targetValue || r.targetValue === '')) &&
          ((!(searchTerm.includes("#inarray") || searchTerm.includes("#ina"))) || (/^.*\.\d+$/).test(r.key)) &&
          ((!(searchTerm.includes("#aifetching") || searchTerm.includes("#aif"))) || (rowAiLoading[r.key] === true))
        )
      )
    })
  ) || [];

  return (
    <div className="app-container">
      {/* Sidebar Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Navigation Sidebar */}
      <aside className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2 className="sidebar-brand">
            <div className="sidebar-brand-icon">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 002 2h1.5a3 3 0 003-3V6.741M17.03 3.394A9.002 9.002 0 004.516 17.657" /></svg>
            </div>
            Multiverse
          </h2>
          <button onClick={() => setIsSidebarOpen(false)} className="sidebar-close-btn">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-nav-header">
            <span>Environments</span>
            <div className="sidebar-action-icons">
              <button onClick={handleImportProject} className="sidebar-action-btn import-btn" title="Import Project">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
              </button>
              <button onClick={handleCreateProject} className="sidebar-action-btn new-btn" title="New Project">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" /></svg>
              </button>
            </div>
          </div>
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => { setActiveProjectId(p.id); setIsSidebarOpen(false); }}
              className={`sidebar-project-btn ${p.id === activeProjectId ? 'active' : ''}`}
            >
              <div className="sidebar-project-btn-header">
                <span className="sidebar-project-name">{p.name}</span>
                <div className="sidebar-project-status">
                  {p.rows.some(r => r.targetValue !== r.originalTargetValue) && (
                    <span className="sidebar-project-dot modified animate-pulse" />
                  )}
                  {p.rows.some(r => r.sourceValue !== r.pastSourceValue) && (
                    <span className="sidebar-project-dot unconfirmed animate-pulse" />
                  )}
                </div>
              </div>
              <span className="sidebar-project-strings">{p.rows.length || 0} strings manifested</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <button
            onClick={() => setIsSpreadsheetMode(!isSpreadsheetMode)}
            className="settings-btn"
            title="Swap UI View Style"
          >
            {isSpreadsheetMode ? (
              <>
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: '1.25rem', height: '1.25rem' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
                Rounded View
              </>
            ) : (
              <>
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ width: '1.25rem', height: '1.25rem' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                Spreadsheet View
              </>
            )}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="settings-btn"
          >
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            Settings
          </button>
        </div>
      </aside>

      {/* Main Content Canvas */}
      <main className="main-canvas">

        {!activeProject ? (
          <div className="empty-view">
            <div className="empty-icon-box">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
            </div>
            <p className="empty-title">MANIFEST MISSING</p>
            <button onClick={handleCreateProject} className="empty-btn">Launch first project</button>
          </div>
        ) : (
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            <header className="header-container">
              <div className="project-title-container">
                {isEditingName ? (
                  <input
                    autoFocus
                    className="project-title-input"
                    value={editNameValue}
                    onChange={e => setEditNameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRenameProject();
                      if (e.key === 'Escape') setIsEditingName(false);
                    }}
                    onBlur={handleRenameProject}
                  />
                ) : (
                  <div className="project-title-group">
                    <h2 onClick={() => setIsEditingName(true)} className="project-title-text">
                      {activeProject.name}
                    </h2>
                    <button
                      onClick={() => setIsEditingName(true)}
                      className="project-edit-btn"
                    >
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                  </div>
                )}
                <div className="project-branch-badge">
                  {activeProject.config.branch || 'main'}
                </div>
              </div>

              <div className="project-actions-container">
                <button
                  onClick={handleExportProject}
                  title="Export Project as File"
                  className="btn btn-icon"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                </button>
                <button
                  onClick={handleCopyLink}
                  title="Share with URL"
                  className="btn btn-icon"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>
                </button>
                <button
                  onClick={handleCopyRawJson}
                  title="Copy Target JSON"
                  className="btn btn-icon"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                </button>
                <button
                  onClick={e => { setShowDialogSuggestAll(true); }}
                  disabled={loading || activeProject.rows.length === 0}
                  className="btn btn-primary"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  <div className="btn-label-collapse">AI Suggest</div>
                </button>
                <button
                  onClick={handlePushToGitHub}
                  disabled={loading || modifiedCount === 0 || !settings.githubToken}
                  className="btn btn-success"
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                  <div className="btn-label-collapse">Push</div>
                </button>
                <button
                  onClick={() => setShowConfig(!showConfig)}
                  className={`btn-config ${showConfig ? 'active' : ''}`}
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                </button>
              </div>
            </header>

            {showConfig && (
              <div className="config-panel animate-slide-down">
                <div className="config-form-container">
                  <h3 className="config-section-title">Local Configuration</h3>
                  <div className="config-row-2col">
                    <div className="form-group">
                      <label className="form-label">Repo Owner</label>
                      <input
                        className="form-input"
                        value={activeProject.config.owner}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, owner: e.target.value } })}
                        placeholder="e.g. google"
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Repo Name</label>
                      <input
                        className="form-input"
                        value={activeProject.config.repo}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, repo: e.target.value } })}
                        placeholder="e.g. gen-ui"
                      />
                    </div>
                  </div>
                  <div className="config-row-2col">
                    <div className="form-group">
                      <label className="form-label">Active Branch</label>
                      <input
                        className="form-input"
                        value={activeProject.config.branch}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, branch: e.target.value } })}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Intelligence Core</label>
                      <select
                        className="form-select"
                        value={activeProject.selectedModel}
                        onChange={e => updateActiveProject({ selectedModel: e.target.value as GeminiModel })}
                      >
                        {Object.values(GeminiModel).map(model => (
                          <option key={model} value={model} title={model.startsWith("gemma") ? "Gemma<=3 is not support json mime (unstable)" : ""}>
                            {model} {model.startsWith("gemma") ? "(unstable)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="config-actions-row">
                    <button
                      onClick={handleFetchFiles}
                      className="btn-dark"
                    >
                      Update from GitHub
                    </button>
                    <button
                      onClick={handleDeleteProject}
                      className="btn-danger-light"
                    >
                      Destroy Project
                    </button>
                    <button
                      onClick={handleRevertProject}
                      className="btn-warning-light"
                    >
                      Revert Project
                    </button>
                  </div>
                </div>
                <div className="config-form-container">
                  <h3 className="config-section-title">Path Mapping</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                    <div className="form-group">
                      <label className="form-label">Source Locale JSON Path</label>
                      <input
                        className="form-input form-input-mono"
                        value={activeProject.config.sourcePath}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, sourcePath: e.target.value } })}
                        placeholder="locales/en.json"
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Target Locale JSON Path</label>
                      <input
                        className="form-input form-input-mono"
                        value={activeProject.config.targetPath}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, targetPath: e.target.value } })}
                        placeholder="locales/ko.json"
                      />
                    </div>
                  </div>
                  <div className="form-group" style={{ marginTop: "2rem" }}>
                    <label className="form-label">Project Note</label>
                    <textarea
                      className="form-textarea"
                      value={activeProject.note || ''}
                      onChange={e => updateActiveProject({ note: e.target.value })}
                      placeholder="Context for translators"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className={`workspace-wrapper ${isSpreadsheetMode ? 'spreadsheet-layout' : ''}`}>
              <div className="filter-bar">
                {isSpreadsheetMode && (
                  <div className="mobile-stats-row">
                    <div className="mobile-stats-wrapper">
                      {unconfirmedCount > 0 && <span className="search-stats-badge unconfirmed">{unconfirmedCount} Unconfirmed</span>}
                      {modifiedCount > 0 && <span className="search-stats-badge modified">{modifiedCount} Modified</span>}
                      <span>{viewMode === ViewMode.TRANSLATIONS ? filteredRows.length : filteredDiffRows.length || 0} Entries</span>
                    </div>
                    <button
                      onClick={() => setIsSearchCollapsedMobile(!isSearchCollapsedMobile)}
                      className="mobile-search-toggle"
                    >
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    </button>
                  </div>
                )}

                <div className="search-input-wrapper" style={{ display: (isSpreadsheetMode && isSearchCollapsedMobile) ? "none" : "block" }}>
                  <input
                    type="text"
                    placeholder="Search strings, keys, or translations..."
                    value={searchTerms}
                    onChange={e => setSearchTerms(e.target.value)}
                    className="search-input"
                  />
                  <button
                    onClick={() => setShowSearchHelp(!showSearchHelp)}
                    className="search-help-btn"
                    title="Search Syntax Help"
                  >
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </button>

                  {showSearchHelp && (
                    <div className="search-help-dropdown animate-slide-down">
                      <div className="search-help-header">
                        <h3 className="search-help-title">Search Syntax</h3>
                        <button onClick={() => setShowSearchHelp(false)} className="search-help-close">
                          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                      <div className="search-help-body custom-scrollbar">
                        <div className="search-help-item">
                          <div className="search-help-item-header">
                            <code className="search-help-tag">||</code>
                            <span className="search-help-tag-title">OR Operator</span>
                          </div>
                          <p className="search-help-desc">Multiple terms: <code>login || logout</code></p>
                        </div>
                        <div className="search-help-item">
                          <div className="search-help-item-header">
                            <code className="search-help-tag">#reg</code>
                            <span className="search-help-tag-title">Regex Search</span>
                          </div>
                          <p className="search-help-desc">Use regular expressions: <code>^auth_.*#reg</code></p>
                        </div>
                        <div className="search-help-item">
                          <div className="search-help-item-header">
                            <code className="search-help-tag">#key</code>
                            <span className="search-help-tag-title">Search Keys Only</span>
                          </div>
                          <p className="search-help-desc">Ignore values: <code>error#key</code></p>
                        </div>
                        <div className="search-help-tags-grid">
                          {[
                            ...(viewMode === ViewMode.DIFFERENCES ? [
                              { tag: "#dremoved, #drem", desc: "Show removed rows in diff" },
                            ] : []),
                            { tag: "#dupdated, #dupd", desc: "Show updated rows in diff" },
                            { tag: "#dtranslated, #dtra", desc: "Show translated(updated while undone) rows in diff" },
                            { tag: "#dmodified, #dmod", desc: "Show modified rows in diff" },
                            { tag: "#dadded, #dadd", desc: "Show added rows in diff" },
                            { tag: "#modified, #mod", desc: "Show modified rows" },
                            { tag: "#unconfirmed, #unc", desc: "Show unconfirmed rows" },
                            { tag: "#empty, #emp", desc: "Missing translations" },
                            { tag: "#done, #don", desc: "Manifest matching remote" },
                            { tag: "#undone, #und", desc: "Undisturbed strings" },
                            { tag: "#doing, #doi", desc: "Active work batch" },
                            { tag: "#ai", desc: "AI suggestions present" },
                            { tag: "#noai, #noa", desc: "No AI data yet" },
                            { tag: "#aifetching, #aif", desc: "Awaiting AI core" },
                            { tag: "#inarray, #ina", desc: "Manifest arrays" }
                          ].map(item => (
                            <div key={item.tag} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                              <code className="search-help-tag" style={{ width: "fit-content" }}>{item.tag}</code>
                              <p className="search-help-tag-title" style={{ fontSize: "9px" }}>{item.desc}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                </div>
                {(!isSpreadsheetMode) && (
                  <div className="search-stats-container no-scrollbar">
                    {unconfirmedCount > 0 && <span className="search-stats-badge unconfirmed">{unconfirmedCount} Unconfirmed</span>}
                    {modifiedCount > 0 && <span className="search-stats-badge modified">{modifiedCount} Modified</span>}
                    <span className="search-stats-divider"></span>
                    <span>{viewMode === ViewMode.TRANSLATIONS ? filteredRows.length : filteredDiffRows.length || 0} Entries</span>
                  </div>
                )}
              </div>

              {/* PROJECT CONSOLE */}
              <div className="project-console">
                <div className="tab-container">
                  {!isConfirming ? (
                    <>
                      <button onClick={() => setViewMode(ViewMode.TRANSLATIONS)} className={`tab-btn ${viewMode === ViewMode.TRANSLATIONS ? 'active' : ''}`}>Translations</button>
                      <button onClick={() => setViewMode(ViewMode.DIFFERENCES)} className={`tab-btn ${viewMode === ViewMode.DIFFERENCES ? 'active' : ''}`}>Differences</button>
                    </>
                  ) : (
                    <>
                      <button onClick={handleApplyDriftDiff} className="tab-btn confirm-diff">Confirm All</button>
                      <button onClick={() => { setIsConfirming(false); setDriftDiff(null); setViewMode(ViewMode.TRANSLATIONS); }} className="tab-btn cancel-diff">Cancel</button>
                    </>
                  )}
                </div>
              </div>

              <div className="rows-viewport" style={{ padding: isSpreadsheetMode ? 0 : undefined }}>
                {viewMode === ViewMode.DIFFERENCES ? (
                  (!activeDiff || activeDiff.rows.length === 0) ? (
                    <div className="empty-view">
                      <div className="empty-icon-box">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      </div>
                      <p className="empty-title">No Differences</p>
                      <p className="dialog-form-desc" style={{ padding: 0 }}>Fetch files to check for drift or view past applied updates.</p>
                    </div>
                  ) : (
                    <div className="grid-table-container">
                      <div className={`grid-header ${viewMode === ViewMode.DIFFERENCES ? 'diff-layout' : ''}`}>
                        <div>ENTRY PATH</div>
                        <div>CURRENT SOURCE VALUE</div>
                        <div>UPDATED SOURCE VALUE</div>
                        <div>TARGET LOCALE</div>
                      </div>
                      <div style={{ height: "100%", display: 'flex', flexDirection: 'column' }}>
                        <Virtuoso
                          style={{ height: "100%", minHeight: "600px" }}
                          data={filteredDiffRows}
                          itemContent={(_, row) => {
                            if (isSpreadsheetMode) {
                              return (
                                <div key={row.key} className={`row-card ${row.state === DiffRowState.ADDED ? 'added' : row.state === DiffRowState.REMOVED ? 'removed' : 'modified'}`}>
                                  <div className="row-cell-sp">
                                    <label className="row-label-mobile">Entry Path</label>
                                    <div className="key-badge-container-sp">
                                      {row.key}
                                      <span className={`diff-badge ${row.state === DiffRowState.ADDED ? 'added' : row.state === DiffRowState.REMOVED ? 'removed' : 'modified'}`}>
                                        {row.state}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="row-cell-sp relative group">
                                    <label className="row-label-mobile">Past Source Value</label>
                                    <div className="source-box-sp">{row.sourceValue}</div>
                                  </div>
                                  <div className="row-cell-sp relative group">
                                    <label className="row-label-mobile">Updated Source Value</label>
                                    <div className={`source-box-sp ${(row.state === DiffRowState.MODIFIED && row.updatedSourceValue !== row.sourceValue) ? 'changed' : ''}`}>{row.updatedSourceValue}</div>
                                    {(row.state === DiffRowState.MODIFIED && row.updatedSourceValue !== row.sourceValue) && (
                                      <span className="badge-flag-sp changed">CHANGED</span>
                                    )}
                                  </div>
                                  <div className="row-cell-sp relative group">
                                    <label className="row-label-mobile">Target Locale</label>
                                    <textarea
                                      className={`edit-textarea-sp ${(row.state === DiffRowState.MODIFIED && row.pastTargetValue !== row.targetValue) ? (row.pastTargetValue !== row.sourceValue ? 'diff-modified' : 'diff-translated') : ''} ${viewingPast[row.key] ? 'bg-rose-50' : ''}`}
                                      value={viewingPast[row.key] ? row.pastTargetValue : row.targetValue}
                                      disabled={isConfirming || row.state === DiffRowState.REMOVED || viewingPast[row.key]}
                                      onChange={e => {
                                        if (!isConfirming && !viewingPast[row.key] && (row.state === DiffRowState.ADDED || row.state === DiffRowState.MODIFIED)) {
                                          const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, targetValue: e.target.value } : r);

                                          let newStack = activeProject.diffStack;
                                          if (activeProject.diffStack && activeProject.diffStack.length > 0) {
                                            newStack = [...activeProject.diffStack];
                                            const lastDiff = { ...newStack[newStack.length - 1] };
                                            const diffIdx = lastDiff.rows.findIndex(d => d.key === row.key);
                                            if (diffIdx !== -1) {
                                              lastDiff.rows[diffIdx] = { ...lastDiff.rows[diffIdx], targetValue: e.target.value };
                                              newStack[newStack.length - 1] = lastDiff;
                                            }
                                          }
                                          updateActiveProject({ rows: newRows, diffStack: newStack });
                                        }
                                      }}
                                    />
                                    {(row.state === DiffRowState.MODIFIED && row.pastTargetValue !== row.targetValue) && (row.pastTargetValue !== row.sourceValue ? (<div className="group">
                                      {viewingPast[row.key] || <span className="badge-flag-sp updated">UPDATED</span>}
                                      <button
                                        className="unconfirm-btn-sp"
                                        onClick={e => {
                                          setViewingPast({ ...viewingPast, [row.key]: !viewingPast[row.key] })
                                        }}
                                      >
                                        {viewingPast[row.key] ? "VIEW CURRENT" : "VIEW PAST"}
                                      </button>
                                    </div>) : (
                                      <span className="badge-flag-sp translated">TRANSLATED</span>
                                    ))}
                                  </div>
                                </div>
                              );
                            } else {
                              return (
                                <div key={row.key} className={`row-card diff-layout ${row.state === DiffRowState.ADDED ? 'added' : row.state === DiffRowState.REMOVED ? 'removed' : 'modified'}`}>
                                  <div className="key-cell">
                                    <label className="row-label-mobile">Entry Path</label>
                                    <div className="key-badge-container">
                                      {row.key}
                                      <span className={`diff-badge ${row.state === DiffRowState.ADDED ? 'added' : row.state === DiffRowState.REMOVED ? 'removed' : 'modified'}`}>
                                        {row.state}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="value-cell">
                                    <label className="row-label-mobile">Past Source Value</label>
                                    <div className="source-box">{row.sourceValue}</div>
                                  </div>
                                  <div className="value-cell">
                                    <label className="row-label-mobile">Updated Source Value</label>
                                    <div className={`source-box ${(row.state === DiffRowState.MODIFIED && row.updatedSourceValue !== row.sourceValue) ? 'changed' : ''}`}>{row.updatedSourceValue}</div>
                                    {(row.state === DiffRowState.MODIFIED && row.updatedSourceValue !== row.sourceValue) && (
                                      <span className="badge-flag changed">CHANGED</span>
                                    )}
                                  </div>
                                  <div className="value-cell view-past-toggle-group">
                                    <label className="row-label-mobile">Target Locale</label>
                                    <textarea
                                      className={`edit-textarea ${(row.state === DiffRowState.MODIFIED && row.pastTargetValue !== row.targetValue) ? (row.pastTargetValue !== row.sourceValue ? 'diff-modified' : 'diff-translated') : ''} ${viewingPast[row.key] ? 'bg-rose' : ''}`}
                                      value={viewingPast[row.key] ? row.pastTargetValue : row.targetValue}
                                      disabled={isConfirming || row.state === DiffRowState.REMOVED || viewingPast[row.key]}
                                      onChange={e => {
                                        if (!isConfirming && !viewingPast[row.key] && (row.state === DiffRowState.ADDED || row.state === DiffRowState.MODIFIED)) {
                                          const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, targetValue: e.target.value } : r);

                                          let newStack = activeProject.diffStack;
                                          if (activeProject.diffStack && activeProject.diffStack.length > 0) {
                                            newStack = [...activeProject.diffStack];
                                            const lastDiff = { ...newStack[newStack.length - 1] };
                                            const diffIdx = lastDiff.rows.findIndex(d => d.key === row.key);
                                            if (diffIdx !== -1) {
                                              lastDiff.rows[diffIdx] = { ...lastDiff.rows[diffIdx], targetValue: e.target.value };
                                              newStack[newStack.length - 1] = lastDiff;
                                            }
                                          }
                                          updateActiveProject({ rows: newRows, diffStack: newStack });
                                        }
                                      }}
                                    />
                                    {(row.state === DiffRowState.MODIFIED && row.pastTargetValue !== row.targetValue) && (row.pastTargetValue !== row.sourceValue ? (<div className="group">
                                      {viewingPast[row.key] || <span className="badge-flag updated">UPDATED</span>}
                                      <button
                                        className={`view-past-toggle-btn ${viewingPast[row.key] ? 'visible' : ''}`}
                                        onClick={e => {
                                          setViewingPast({ ...viewingPast, [row.key]: !viewingPast[row.key] })
                                        }}
                                      >
                                        {viewingPast[row.key] ? "VIEW CURRENT" : "VIEW PAST"}
                                      </button>
                                    </div>) : (
                                      <span className="badge-flag translated">TRANSLATED</span>
                                    ))}
                                  </div>
                                </div>
                              );
                            }
                          }}
                        />
                      </div>
                    </div>
                  )
                ) : (
                  filteredRows.length === 0 ? (
                    <div className="empty-view">
                      <div className="empty-icon-box">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                      </div>
                      {
                        activeProject.rows.length > 0
                          ? <div>
                            <p className="empty-title">No Search Results</p>
                            <p className="dialog-form-desc" style={{ padding: 0 }}>Try different search terms.</p>
                          </div>
                          : <div>
                            <p className="empty-title">Manifest Empty</p>
                            <p className="dialog-form-desc" style={{ padding: 0 }}>Fetch files from your repository to start real-time localization.</p>
                          </div>
                      }
                    </div>
                  ) : (
                    <div className="grid-table-container">
                      {/* Header for Desktop */}
                      <div className="grid-header">
                        <div>ENTRY PATH</div>
                        <div>SOURCE STRING</div>
                        <div>TARGET LOCALE</div>
                        <div>AI SUGGESTION</div>
                      </div>

                      <div style={{ height: "100%", display: 'flex', flexDirection: 'column' }}>
                        <Virtuoso
                          style={{ height: "100%", minHeight: "600px" }}
                          data={filteredRows}
                          itemContent={(_, row) => {
                            if (isSpreadsheetMode) {
                              return (
                                <div key={row.key} className={`row-card ${row.targetValue !== row.originalTargetValue ? 'modified' : ''}`}>
                                  {/* Key Column */}
                                  <div className="row-cell-sp">
                                    <label className="row-label-mobile">Entry Path</label>
                                    <div className="key-badge-container-sp">
                                      {row.key}
                                      {keyDiffMap.get(row.key) && (
                                        <span className={`diff-badge ${keyDiffMap.get(row.key)?.state === DiffRowState.ADDED ? 'added' : keyDiffMap.get(row.key)?.state === DiffRowState.REMOVED ? 'removed' : 'modified'}`}>
                                          {keyDiffMap.get(row.key)?.state}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Source Column */}
                                  <div className="row-cell-sp relative group">
                                    <label className="row-label-mobile">Source String</label>
                                    <div className={`source-box-sp ${row.pastSourceValue !== row.sourceValue ? 'unconfirm' : ''}`}>
                                      {row.sourceValue}
                                      {row.pastSourceValue !== row.sourceValue && (<>
                                        <span className="badge-flag-sp unconfirmed">
                                          Unconfirm
                                        </span>
                                        <button
                                          onClick={() => {
                                            const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, pastSourceValue: row.sourceValue } : r);
                                            updateActiveProject({ rows: newRows });
                                          }}
                                          className="unconfirm-btn-sp"
                                        >
                                          <svg style={{ width: "0.75rem", height: "0.75rem", display: "inline-block" }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                        </button>
                                      </>)}
                                    </div>
                                  </div>

                                  {/* Target Column */}
                                  <div className="row-cell-sp relative group">
                                    <label className="row-label-mobile">Target Locale</label>
                                    <textarea
                                      className={`edit-textarea-sp ${row.targetValue !== row.originalTargetValue ? 'modified' : ''}`}
                                      value={row.targetValue}
                                      onChange={e => {
                                        const newRows = activeProject.rows.map(r => r.key === row.key ? {
                                          ...r,
                                          targetValue: e.target.value !== "\t" ? e.target.value : row.originalTargetValue
                                        } : r);
                                        updateActiveProject({ rows: newRows });
                                      }}
                                      onKeyDown={e => {
                                        if (e.key === 'Tab') {
                                          e.preventDefault();
                                          const newRows = activeProject.rows.map(r => r.key === row.key ? {
                                            ...r,
                                            targetValue: row.originalTargetValue
                                          } : r);
                                          updateActiveProject({ rows: newRows });
                                        }
                                      }}
                                      placeholder={row.originalTargetValue === '' || !row.originalTargetValue ? "Add translation..." : "Tab to Revert: ".concat(row.originalTargetValue)}
                                    />
                                    {row.targetValue !== row.originalTargetValue && (
                                      <span className="badge-flag-sp modified">Modified</span>
                                    )}
                                  </div>

                                  {/* AI Column */}
                                  <div className="row-cell-sp relative group">
                                    <label className="row-label-mobile">AI Suggestion</label>
                                    <div
                                      className={`ai-suggest-box-sp ${row.aiSuggestion && !rowAiLoading[row.key] ? 'has-suggestion' : 'no-suggestion'}`}
                                    >
                                      {row.aiSuggestion && !rowAiLoading[row.key] ? row.aiSuggestion : (rowAiTemp[row.key] && rowAiLoading[row.key] ? <div>{row.aiSuggestion || rowAiTemp[row.key]}<div className="ai-loading-container" style={{ position: "relative", width: "1rem", height: "1rem", display: "inline-block" }}>
                                        <div className="spinner-track" style={{ borderWidth: "2px" }}></div>
                                        <div className="spinner-hand animate-spin" style={{ borderWidth: "2px" }}></div>
                                      </div></div> : (rowAiLoading[row.key] ?
                                        <div className="ai-loading-container" style={{ flexDirection: "row" }}>
                                          Awaiting AI
                                          <div style={{ position: "relative", width: "1rem", height: "1rem", display: "inline-block", marginLeft: "0.25rem" }}>
                                            <div className="spinner-track" style={{ borderWidth: "2px" }}></div>
                                            <div className="spinner-hand animate-spin" style={{ borderWidth: "2px" }}></div>
                                          </div>
                                        </div> : "No AI"))}
                                    </div>
                                    {row.aiSuggestion && !rowAiLoading[row.key] ? (
                                      <div>
                                        <button
                                          onClick={() => {
                                            const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, aiSuggestion: "" } : r);
                                            updateActiveProject({ rows: newRows });
                                          }}
                                          className="ai-action-btn-sp discard"
                                        >
                                          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18 18 6M6 6l12 12" /></svg>
                                        </button>
                                        <button
                                          onClick={() => {
                                            const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, targetValue: row.aiSuggestion || r.targetValue } : r);
                                            updateActiveProject({ rows: newRows });
                                          }}
                                          className="ai-action-btn-sp accept"
                                        >
                                          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                        </button>
                                      </div>
                                    ) : (
                                      rowAiLoading[row.key] || <button
                                        onClick={async () => {
                                          const updatedRows = [...activeProject.rows];

                                          if (!settings.geminiApiKey) {
                                            alert("⚠️ Gemini API Key Missing\nTo use AI suggestions, click the Settings button and use 'Authenticate Gemini' to select your API key.");
                                            setShowSettings(true);
                                            return;
                                          }
                                          try {
                                            setRowAiLoading({ ...rowAiLoading, [row.key]: true });
                                            const suggestions = await getTranslationSuggestions(
                                              activeProject.selectedModel, settings.geminiApiKey,
                                              activeProject.config.sourcePath.split('/').pop()?.replace('.json', '') || 'Source',
                                              activeProject.config.targetPath.split('/').pop()?.replace('.json', '') || 'Target',
                                              [{ key: row.key, value: row.sourceValue }],
                                              activeProject.note?.replace("\n", ", ")
                                            );
                                            setRowAiLoading({ ...rowAiLoading, [row.key]: false });
                                            Object.keys(suggestions).forEach(key => {
                                              const rowIndex = updatedRows.findIndex(r => r.key === key);
                                              if (rowIndex !== -1) updatedRows[rowIndex].aiSuggestion = suggestions[key];
                                            });
                                            updateActiveProject({ rows: updatedRows });
                                          } catch (error) {
                                            console.error("Error fetching AI suggestion:", error);
                                            alert("⚠️ Error fetching AI suggestion. Please check the console for details.");
                                          } finally {
                                          }
                                        }}
                                        className="ai-suggest-trigger-btn-sp"
                                      >
                                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            } else {
                              return (
                                <div key={row.key} className={`row-card ${row.targetValue !== row.originalTargetValue ? 'modified' : ''}`}>
                                  {/* Key Column */}
                                  <div className="key-cell">
                                    <label className="row-label-mobile">Entry Path</label>
                                    <div className="key-badge-container">
                                      {row.key}
                                      {keyDiffMap.get(row.key) && (
                                        <span className={`diff-badge ${keyDiffMap.get(row.key)?.state === DiffRowState.ADDED ? 'added' : keyDiffMap.get(row.key)?.state === DiffRowState.REMOVED ? 'removed' : 'modified'}`}>
                                          {keyDiffMap.get(row.key)?.state}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Source Column */}
                                  <div className="value-cell">
                                    <label className="row-label-mobile">Source String</label>
                                    <div className={`source-box ${row.pastSourceValue !== row.sourceValue ? 'unconfirm' : ''}`}>
                                      {row.sourceValue}
                                      {row.pastSourceValue !== row.sourceValue && (<>
                                        <span className="badge-flag unconfirmed">
                                          Unconfirm
                                        </span>
                                        <button
                                          onClick={() => {
                                            const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, pastSourceValue: row.sourceValue } : r);
                                            updateActiveProject({ rows: newRows });
                                          }}
                                          className="unconfirm-btn-overlay"
                                        >
                                          <svg style={{ width: "1.25rem", height: "1.25rem", display: "inline-block" }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                        </button>
                                      </>)}
                                    </div>
                                  </div>

                                  {/* Target Column */}
                                  <div className="value-cell">
                                    <label className="row-label-mobile">Target Locale</label>
                                    <textarea
                                      className={`edit-textarea ${row.targetValue !== row.originalTargetValue ? 'modified' : ''}`}
                                      value={row.targetValue}
                                      onChange={e => {
                                        const newRows = activeProject.rows.map(r => r.key === row.key ? {
                                          ...r,
                                          targetValue: e.target.value !== "\t" ? e.target.value : row.originalTargetValue
                                        } : r);
                                        updateActiveProject({ rows: newRows });
                                      }}
                                      onKeyDown={e => {
                                        if (e.key === 'Tab') {
                                          e.preventDefault();
                                          const newRows = activeProject.rows.map(r => r.key === row.key ? {
                                            ...r,
                                            targetValue: row.originalTargetValue
                                          } : r);
                                          updateActiveProject({ rows: newRows });
                                        }
                                      }}
                                      placeholder={row.originalTargetValue === '' || !row.originalTargetValue ? "Add translation..." : "Tab to Revert: ".concat(row.originalTargetValue)}
                                    />
                                    {row.targetValue !== row.originalTargetValue && (
                                      <span className="badge-flag modified">Modified</span>
                                    )}
                                  </div>

                                  {/* AI Column */}
                                  <div className="value-cell">
                                    <label className="row-label-mobile">AI Suggestion</label>
                                    <div
                                      className={`ai-suggest-box ${row.aiSuggestion && !rowAiLoading[row.key] ? 'has-suggestion' : (rowAiTemp[row.key] && rowAiLoading[row.key] ? 'loading-temp' : 'no-suggestion')}`}
                                    >
                                      {row.aiSuggestion && !rowAiLoading[row.key] ? row.aiSuggestion : (rowAiTemp[row.key] && rowAiLoading[row.key] ? <div>{row.aiSuggestion || rowAiTemp[row.key]}<div className="ai-loading-container" style={{ position: "relative", width: "1rem", height: "1rem" }}>
                                        <div className="spinner-track" style={{ borderWidth: "2px" }}></div>
                                        <div className="spinner-hand animate-spin" style={{ borderWidth: "2px" }}></div>
                                      </div></div> : (rowAiLoading[row.key] ?
                                        <div className="ai-loading-container">
                                          Awaiting AI
                                          <div style={{ position: "relative", width: "2rem", height: "2rem" }}>
                                            <div className="spinner-track" style={{ borderWidth: "4px" }}></div>
                                            <div className="spinner-hand animate-spin" style={{ borderWidth: "4px" }}></div>
                                          </div>
                                        </div> : "No AI"))}
                                    </div>
                                    {row.aiSuggestion && !rowAiLoading[row.key] ? (
                                      <div>
                                        <button
                                          onClick={() => {
                                            const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, aiSuggestion: "" } : r);
                                            updateActiveProject({ rows: newRows });
                                          }}
                                          className="ai-action-btn discard"
                                        >
                                          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18 18 6M6 6l12 12" /></svg>
                                        </button>
                                        <button
                                          onClick={() => {
                                            const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, targetValue: row.aiSuggestion || r.targetValue } : r);
                                            updateActiveProject({ rows: newRows });
                                          }}
                                          className="ai-action-btn accept"
                                        >
                                          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                        </button>
                                      </div>
                                    ) : (
                                      rowAiLoading[row.key] || <button
                                        onClick={async () => {
                                          const updatedRows = [...activeProject.rows];

                                          if (!settings.geminiApiKey) {
                                            alert("⚠️ Gemini API Key Missing\nTo use AI suggestions, click the Settings button and use 'Authenticate Gemini' to select your API key.");
                                            setShowSettings(true);
                                            return;
                                          }
                                          try {
                                            setRowAiLoading({ ...rowAiLoading, [row.key]: true });
                                            const suggestions = await getTranslationSuggestions(
                                              activeProject.selectedModel, settings.geminiApiKey,
                                              activeProject.config.sourcePath.split('/').pop()?.replace('.json', '') || 'Source',
                                              activeProject.config.targetPath.split('/').pop()?.replace('.json', '') || 'Target',
                                              [{ key: row.key, value: row.sourceValue }],
                                              activeProject.note?.replace("\n", ", ")
                                            );
                                            setRowAiLoading({ ...rowAiLoading, [row.key]: false });
                                            Object.keys(suggestions).forEach(key => {
                                              const rowIndex = updatedRows.findIndex(r => r.key === key);
                                              if (rowIndex !== -1) updatedRows[rowIndex].aiSuggestion = suggestions[key];
                                            });
                                            updateActiveProject({ rows: updatedRows });
                                          } catch (error) {
                                            console.error("Error fetching AI suggestion:", error);
                                            alert("⚠️ Error fetching AI suggestion. Please check the console for details.");
                                          } finally {
                                          }
                                        }}
                                        className="ai-suggest-trigger-btn"
                                      >
                                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            }
                          }}
                        />

                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Mobile Header Toggle */}
        <button
          onClick={() => setIsSidebarOpen(true)}
          className="mobile-sidebar-toggle-btn"
        >
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 12h16m-7 6h7" /></svg>
        </button>

        {/* Global Settings Dialog */}
        {showSettings && (
          <div className="dialog-overlay">
            <div className="dialog-modal">
              <div className="dialog-content-wrapper">
                <div className="dialog-modal-header">
                  <div className="dialog-modal-title-group">
                    <h2>Global Config</h2>
                    <p className="dialog-modal-subtitle">Local Memory Sync</p>
                  </div>
                  <button onClick={() => setShowSettings(false)} className="dialog-close-btn">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="dialog-form-sections">
                  <section>
                    <div className="dialog-section-header">
                      <div className="dialog-indicator-bar"></div>
                      <label className="dialog-section-label">GitHub Auth Token</label>
                    </div>
                    <input
                      type="password"
                      placeholder="**************************************"
                      className="form-input form-input-mono"
                      value={settings.githubToken}
                      onChange={e => setSettings({ ...settings, githubToken: e.target.value })}
                    />
                    <p className="dialog-form-desc">
                      Manifest Encryption: Tokens are stored exclusively in your browser's private localStorage. We never route keys through proxy servers.
                    </p>
                  </section>

                  <section>
                    <div className="dialog-section-header">
                      <div className="dialog-indicator-bar"></div>
                      <label className="dialog-section-label">Gemini API Key</label>
                    </div>
                    <input
                      type="password"
                      placeholder="**************************************"
                      className="form-input form-input-mono"
                      value={settings.geminiApiKey}
                      onChange={e => setSettings({ ...settings, geminiApiKey: e.target.value })}
                    />
                    <p className="dialog-form-desc">
                      Manifest Encryption: Tokens are stored exclusively in your browser's private localStorage. We never route keys through proxy servers.
                    </p>
                  </section>

                  <section>
                    <div className="dialog-section-header">
                      <div className="dialog-indicator-bar"></div>
                      <label className="dialog-section-label">AI Suggestion Chunk Size: {settings.suggestionChunkSize}</label>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      className="range-input"
                      value={settings.suggestionChunkSize}
                      onChange={e => setSettings({ ...settings, suggestionChunkSize: parseInt(e.target.value) })}
                    />
                  </section>
                </div>

                <div className="dialog-footer-panel">
                  <button
                    onClick={() => setShowSettings(false)}
                    className="dialog-submit-btn primary"
                  >
                    Confirm & Sync Manifest
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* AI Suggestions Dialog */}
        {showDialogSuggestAll && (
          <div className="dialog-overlay">
            <div className="dialog-modal">
              <div className="dialog-content-wrapper bg-indigo-light">
                <div className="dialog-modal-header">
                  <div className="dialog-modal-title-group">
                    <h2>AI Suggest</h2>
                    <p className="dialog-modal-subtitle">for all of current filtered rows</p>
                  </div>
                  <button onClick={() => setShowDialogSuggestAll(false)} className="dialog-close-btn">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="dialog-form-sections">
                  <section>
                    <div className="dialog-section-header">
                      <div className="dialog-indicator-bar"></div>
                      <label className="dialog-section-label">Additional Instructions</label>
                    </div>
                    <input
                      type="text"
                      placeholder="e.g. Use formal language, local idioms, etc."
                      className="form-input"
                      value={additionalInstructions}
                      onChange={e => setAdditionalInstructions(e.target.value)}
                    />
                  </section>
                  <section>
                    <button
                      className={`toggle-option-btn ${replaceExistAISuggestions ? 'active' : ''}`}
                      onClick={() => setReplaceExistAISuggestions(!replaceExistAISuggestions)}
                    >
                      <div className="toggle-checkbox-indicator">
                        {replaceExistAISuggestions && <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <div style={{ fontSize: "12px", fontWeight: "900", textTransform: "uppercase", letterSpacing: "0.1em" }}>Replace Existing AI Suggestions</div>
                    </button>
                  </section>
                </div>

                <div className="dialog-footer-panel">
                  <button
                    onClick={() => {
                      setShowDialogSuggestAll(false);
                      handleSuggestAll();
                    }}
                    className="dialog-submit-btn indigo-modal"
                  >
                    Confirm & AI Suggest
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="loader-overlay">
            <div className="loader-card">
              <div className="loader-spinner-container">
                <div className="spinner-track"></div>
                <div className="spinner-hand animate-spin"></div>
              </div>
              <div>
                <p className="loader-title">Synthesizing...</p>
                <p className="loader-subtitle">Synchronizing timeline data</p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
