
import React, { useState, useEffect, useMemo } from 'react';
import { GitHubConfig, TranslationRow, GeminiModel, Project, GlobalState, GlobalSettings, ValueType } from './types';
import { flattenObject, unflattenObject, saveToLocal, loadFromLocal, downloadFile, importProject as importProjectFromText } from './utils';
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

  // Load from Browser Storage
  useEffect(() => {
    const saved = loadFromLocal(STORAGE_KEY) as GlobalState;
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
    }
  }, []);

  // Save to Browser Storage on every state change
  useEffect(() => {
    if (projects.length > 0) {
      saveToLocal(STORAGE_KEY, { projects, activeProjectId, settings });
    }
  }, [projects, activeProjectId, settings]);

  const activeProject = useMemo(() =>
    projects.find(p => p.id === activeProjectId) || null
    , [projects, activeProjectId]);

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
      selectedModel: GeminiModel['G3-FLASH-PRE'],
      lastUpdated: Date.now(),
      originalTargetData: {},
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

      const newRows: TranslationRow[] = Object.keys(flatSource).filter(key => {
        let row = activeProject?.rows.filter(r => r.key === key)[0];
        return typeof flatSource[key] === 'string';
      }).map(key => {
        let row = activeProject?.rows.filter(r => r.key === key)[0];
        return ({
          key,
          sourceValue: flatSource[key].toString(),
          targetValue: (activeProject ? row?.targetValue === row?.originalTargetValue : true) ? (flatTarget[key] ? flatTarget[key].toString() : flatSource[key].toString()) : row?.targetValue || '',
          originalTargetValue: flatTarget[key] ? flatTarget[key].toString() : flatSource[key].toString(),
          aiSuggestion: row ? (row.aiSuggestion || '') : '',
        });
      });

      updateActiveProject({ rows: newRows, originalTargetData: target });
      setShowConfig(false);
    } catch (err: any) {
      alert(`GitHub Sync Failed: ${err.message}`);
    } finally {
      setLoading(false);
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

        const suggestions = await getTranslationSuggestions(
          activeProject.selectedModel, settings.geminiApiKey,
          activeProject.config.sourcePath.split('/').pop()?.replace('.json', '') || 'Source',
          activeProject.config.targetPath.split('/').pop()?.replace('.json', '') || 'Target',
          sourceTexts,
          additionalInstructions
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
    const url = window.location.origin + window.location.pathname + "?import=" + encodeURIComponent(jsonString);
    if (url.length > 2000) {
      alert("Project is too large to be shared via URL! Use Export Project as File instead.");
      return;
    }
    navigator.clipboard.writeText(url);
    alert("Project URL copied to clipboard!");
  };

  const filteredRows = activeProject?.rows?.filter?.(r =>
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
          ((!searchTerm.includes("#modified")) || r.targetValue !== r.originalTargetValue) &&
          ((!searchTerm.includes("#done")) || r.sourceValue !== r.originalTargetValue && r.targetValue === r.originalTargetValue) &&
          ((!searchTerm.includes("#undone")) || r.sourceValue === r.targetValue || !r.targetValue || r.targetValue == '') &&
          ((!searchTerm.includes("#doing")) || r.sourceValue === r.targetValue || !r.targetValue || r.targetValue == '' || r.targetValue !== r.originalTargetValue) &&
          ((!searchTerm.includes("#ai")) || (r.aiSuggestion && r.aiSuggestion !== '')) &&
          ((!searchTerm.includes("#noai")) || (!r.aiSuggestion || r.aiSuggestion === '' || !rowAiLoading[r.key])) &&
          ((!searchTerm.includes("#empty")) || (!r.targetValue || r.targetValue === '')) &&
          ((!searchTerm.includes("#inarray")) || (/^.*\.\d+$/).test(r.key)) &&
          ((!searchTerm.includes("#aifetching")) || (rowAiLoading[r.key] === true))
        )
      )
    })
  ) || [];

  const modifiedCount = activeProject?.rows.filter(r => r.targetValue !== r.originalTargetValue).length || 0;

  return (
    <div className="flex h-screen bg-white overflow-hidden text-slate-900 font-sans selection:bg-indigo-100">
      {/* Sidebar Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Navigation Sidebar */}
      <aside className={`fixed lg:static inset-y-0 left-0 w-80 bg-slate-900 flex flex-col border-r border-slate-800 shadow-2xl z-50 transition-transform duration-300 transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-8 lg:p-10 flex items-center justify-between">
          <h2 className="text-white text-2xl lg:text-3xl font-black flex items-center gap-4 tracking-tighter cursor-default">
            <div className="bg-gradient-to-tr from-indigo-500 to-violet-600 w-10 h-10 lg:w-12 lg:h-12 rounded-[1.25rem] flex items-center justify-center text-xs shadow-2xl shadow-indigo-500/40">
              <svg className="w-6 h-6 lg:w-7 lg:h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 002 2h1.5a3 3 0 003-3V6.741M17.03 3.394A9.002 9.002 0 004.516 17.657" /></svg>
            </div>
            Multiverse
          </h2>
          <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden text-slate-400 p-2">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-6 space-y-3">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-4 flex justify-between items-center px-4">
            <span>Environments</span>
            <div className="flex gap-1">
              <button onClick={handleImportProject} className="text-slate-400 hover:text-indigo-400 transition-colors p-1.5 rounded-lg hover:bg-slate-800" title="Import Project">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
              </button>
              <button onClick={handleCreateProject} className="text-indigo-400 hover:text-indigo-300 transition-colors p-1.5 rounded-lg hover:bg-slate-800" title="New Project">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" /></svg>
              </button>
            </div>
          </div>
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => { setActiveProjectId(p.id); setIsSidebarOpen(false); }}
              className={`w-full text-left p-4 lg:p-5 rounded-[1.5rem] transition-all group flex flex-col border ${p.id === activeProjectId ? 'bg-slate-800 text-white shadow-2xl border-slate-700' : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200 border-transparent'}`}
            >
              <div className="flex justify-between items-center w-full">
                <span className="font-bold truncate text-sm">{p.name}</span>
                {p.rows.some(r => r.targetValue !== r.originalTargetValue) && (
                  <span className="w-2.5 h-2.5 bg-amber-400 rounded-full shadow-[0_0_12px_rgba(251,191,36,0.6)] animate-pulse" />
                )}
              </div>
              <span className="text-[10px] font-mono opacity-30 mt-2 uppercase tracking-widest">{p.rows.length || 0} strings manifested</span>
            </button>
          ))}
        </nav>

        <div className="p-8 border-t border-slate-800">
          <button
            onClick={() => setShowSettings(true)}
            className="w-full py-4 px-6 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-3xl flex items-center gap-4 font-bold transition-all text-sm group"
          >
            <svg className="w-5 h-5 group-hover:rotate-90 transition-transform duration-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            Settings
          </button>
        </div>
      </aside>

      {/* Main Content Canvas */}
      <main style={{ height: "100%" }} className="flex-1 flex flex-col relative bg-slate-50 overflow-hidden">

        {!activeProject ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-300 p-6 text-center">
            <div className="w-24 h-24 bg-white rounded-[2.5rem] mb-8 shadow-sm flex items-center justify-center border border-slate-100">
              <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
            </div>
            <p className="font-black text-xl text-slate-400">MANIFEST MISSING</p>
            <button onClick={handleCreateProject} className="mt-4 text-indigo-600 font-bold hover:underline">Launch first project</button>
          </div>
        ) : (
          <div style={{ height: "100%" }}>
            <header className="bg-white border-b border-slate-200 px-6 lg:px-12 pt-20 lg:pt-8 pb-6 lg:pb-8 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6 z-30 shadow-sm">
              <div className="flex items-center gap-4 w-full lg:w-auto">
                {isEditingName ? (
                  <div className="flex items-center gap-2 w-full lg:w-auto">
                    <input
                      autoFocus
                      className="bg-slate-50 border-2 border-indigo-200 rounded-2xl px-5 py-2.5 font-black text-2xl lg:text-3xl tracking-tighter outline-none focus:ring-8 focus:ring-indigo-500/5 w-full"
                      value={editNameValue}
                      onChange={e => setEditNameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRenameProject();
                        if (e.key === 'Escape') setIsEditingName(false);
                      }}
                      onBlur={handleRenameProject}
                    />
                  </div>
                ) : (
                  <div className="group flex items-center gap-4">
                    <h2 onClick={() => setIsEditingName(true)} className="font-black text-2xl lg:text-4xl text-slate-900 tracking-tighter leading-none cursor-pointer hover:text-indigo-600 transition-colors">{activeProject.name}</h2>
                    <button
                      onClick={() => setIsEditingName(true)}
                      className="p-2 text-slate-300 hover:text-indigo-500 transition-colors lg:opacity-0 lg:group-hover:opacity-100 bg-slate-50 rounded-xl"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                  </div>
                )}
                <div className="hidden lg:flex items-center gap-2 ml-4">
                  <span className="text-[10px] text-indigo-700 font-black bg-indigo-50 px-3 py-1 rounded-full uppercase tracking-widest border border-indigo-100/50">
                    {activeProject.config.branch || 'main'}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="flex gap-2">
                  <button
                    onClick={handleExportProject}
                    title="Export Project as File"
                    className="flex-none px-2 py-3.5 lg:px-2 lg:py-4 bg-slate-50 text-slate-500 hover:bg-slate-100 rounded-2xl border border-slate-100 flex items-center justify-center transition-all"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                  </button>
                  <button
                    onClick={handleCopyLink}
                    title="Share with URL"
                    className="flex-none px-2 py-3.5 lg:px-2 lg:py-4 bg-slate-50 text-slate-500 hover:bg-slate-100 rounded-2xl border border-slate-100 flex items-center justify-center transition-all"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>
                  </button>
                  <button
                    onClick={handleCopyRawJson}
                    title="Copy Target JSON"
                    className="flex-none px-2 py-3.5 lg:px-2 lg:py-4 bg-slate-50 text-slate-500 hover:bg-slate-100 rounded-2xl border border-slate-100 flex items-center justify-center transition-all"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                  </button>
                  <button
                    onClick={e => { setShowDialogSuggestAll(true); }}
                    disabled={loading || activeProject.rows.length === 0}
                    className="flex-none p-3.5 lg:px-8 lg:py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl shadow-xl shadow-indigo-600/20 flex items-center justify-center gap-3 text-sm font-black disabled:opacity-50 transition-all active:scale-95"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    <div className="max-xl:hidden">AI Suggest</div>
                  </button>
                </div>
                <button
                  onClick={handlePushToGitHub}
                  disabled={loading || modifiedCount === 0 || !settings.githubToken}
                  className="flex-none p-3.5 lg:px-8 lg:py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl shadow-xl shadow-emerald-600/20 flex items-center justify-center gap-3 text-sm font-black disabled:opacity-50 transition-all active:scale-95"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                  <div className="max-xl:hidden">Push</div>
                </button>
                <button
                  onClick={() => setShowConfig(!showConfig)}
                  className={`p-3.5 lg:p-4 rounded-2xl border transition-all ${showConfig ? 'bg-indigo-50 text-indigo-600 border-indigo-200' : 'bg-white text-slate-400 border-slate-200 shadow-sm hover:bg-slate-100'}`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                </button>
              </div>
            </header>

            {showConfig && (
              <div className="bg-white border-b border-slate-200 p-6 lg:p-12 grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-16 animate-in fade-in slide-in-from-top-8 duration-500 z-20 shadow-2xl overflow-y-auto max-h-[75vh]">
                <div className="space-y-8">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">Local Configuration</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-2">Repo Owner</label>
                      <input
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-4 focus:ring-indigo-500/5 transition-all"
                        value={activeProject.config.owner}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, owner: e.target.value } })}
                        placeholder="e.g. google"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-2">Repo Name</label>
                      <input
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-4 focus:ring-indigo-500/5 transition-all"
                        value={activeProject.config.repo}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, repo: e.target.value } })}
                        placeholder="e.g. gen-ui"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-2">Active Branch</label>
                      <input
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-4 focus:ring-indigo-500/5 transition-all"
                        value={activeProject.config.branch}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, branch: e.target.value } })}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-2">Intelligence Core</label>
                      <select
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none appearance-none cursor-pointer"
                        value={activeProject.selectedModel}
                        onChange={e => updateActiveProject({ selectedModel: e.target.value as GeminiModel })}
                      >
                        {Object.values(GeminiModel).map(model => (
                          <option value={model} title={model.startsWith("gemma") ? "Gemma<=3 is not support json mime (unstable)" : ""}>
                            {model} {model.startsWith("gemma") ? "(unstable)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="pt-6 flex flex-col sm:flex-row gap-4">
                    <button
                      onClick={handleFetchFiles}
                      className="flex-1 py-4 lg:py-5 bg-slate-900 text-white rounded-[2rem] font-black hover:bg-black transition-all text-xs uppercase tracking-widest shadow-2xl active:scale-95"
                    >
                      Update from GitHub
                    </button>
                    <button
                      onClick={handleDeleteProject}
                      className="py-4 lg:py-5 px-8 bg-rose-50 text-rose-600 rounded-[2rem] font-black hover:bg-rose-100 transition-all text-xs uppercase tracking-widest border border-rose-100 active:scale-95"
                    >
                      Destroy Project
                    </button>
                    <button
                      onClick={handleRevertProject}
                      className="py-4 lg:py-5 px-8 bg-amber-50 text-amber-600 rounded-[2rem] font-black hover:bg-amber-100 transition-all text-xs uppercase tracking-widest border border-amber-100 active:scale-95"
                    >
                      Revert Project
                    </button>
                  </div>
                </div>
                <div className="space-y-8">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">Path Mapping</h3>
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-2">Source Locale JSON Path</label>
                      <input
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-4 focus:ring-indigo-500/5 transition-all font-mono"
                        value={activeProject.config.sourcePath}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, sourcePath: e.target.value } })}
                        placeholder="locales/en.json"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase ml-2">Target Locale JSON Path</label>
                      <input
                        className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm outline-none focus:ring-4 focus:ring-indigo-500/5 transition-all font-mono"
                        value={activeProject.config.targetPath}
                        onChange={e => updateActiveProject({ config: { ...activeProject.config, targetPath: e.target.value } })}
                        placeholder="locales/ko.json"
                      />
                    </div>
                    <div className="p-6 bg-slate-900 rounded-3xl border border-slate-800 flex items-start gap-4">
                      <div className="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center shrink-0 shadow-lg">
                        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed font-bold italic">Manual manifest clearing: Updating paths resets the local progress buffer for that project. Sync from GitHub to re-populate.</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ height: "100%" }} className="flex-1 overflow-hidden flex flex-col bg-slate-50/20">
              <div className="px-6 lg:px-12 py-4 lg:py-6 bg-white border-b border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4 sticky top-0 z-20">
                <div className="relative w-full lg:max-w-4xl">
                  <input
                    type="text"
                    placeholder="Search strings, keys, or translations..."
                    value={searchTerms}
                    onChange={e => setSearchTerms(e.target.value)}
                    className="w-full pl-12 lg:pl-14 pr-16 py-3.5 lg:py-4 bg-slate-50 border-none rounded-[1.5rem] text-sm outline-none focus:ring-8 focus:ring-indigo-500/5 transition-all shadow-inner"
                  />
                  <svg className="w-5 h-5 lg:w-6 lg:h-6 absolute left-4 lg:left-5 top-3 lg:top-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <button
                    onClick={() => setShowSearchHelp(!showSearchHelp)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-slate-300 hover:text-indigo-500 transition-colors"
                    title="Search Syntax Help"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </button>

                  {showSearchHelp && (
                    <div className="absolute top-full left-0 mt-4 w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-100 p-8 z-60 animate-slide-down">
                      <div className="flex justify-between items-center mb-6">
                        <h3 className="font-black text-slate-900 uppercase tracking-tighter">Search Syntax</h3>
                        <button onClick={() => setShowSearchHelp(false)} className="text-slate-400 hover:text-slate-900">
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                      <div className="grid grid-cols-1 gap-4 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <code className="bg-slate-100 px-2 py-1 rounded text-indigo-600 font-bold">||</code>
                            <span className="text-xs text-slate-500 font-bold uppercase tracking-wider">OR Operator</span>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed font-medium pl-2 border-l-2 border-slate-100">Multiple terms: <code className="text-slate-600">login || logout</code></p>
                        </div>
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <code className="bg-slate-100 px-2 py-1 rounded text-indigo-600 font-bold">#reg</code>
                            <span className="text-xs text-slate-500 font-bold uppercase tracking-wider">Regex Search</span>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed font-medium pl-2 border-l-2 border-slate-100">Use regular expressions: <code className="text-slate-600">^auth_.*#reg</code></p>
                        </div>
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <code className="bg-slate-100 px-2 py-1 rounded text-indigo-600 font-bold">#key</code>
                            <span className="text-xs text-slate-500 font-bold uppercase tracking-wider">Search Keys Only</span>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed font-medium pl-2 border-l-2 border-slate-100">Ignore values: <code className="text-slate-600">error#key</code></p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-6 pt-4 border-t border-slate-50">
                          {[
                            { tag: "#modified", desc: "Show pending changes" },
                            { tag: "#empty", desc: "Missing translations" },
                            { tag: "#done", desc: "Manifest matching remote" },
                            { tag: "#undone", desc: "Undisturbed strings" },
                            { tag: "#doing", desc: "Active work batch" },
                            { tag: "#ai", desc: "AI suggestions present" },
                            { tag: "#noai", desc: "No AI data yet" },
                            { tag: "#aifetching", desc: "Awaiting AI core" },
                            { tag: "#inarray", desc: "Manifest arrays" }
                          ].map(item => (
                            <div key={item.tag} className="space-y-1">
                              <code className="text-indigo-600 font-black text-xs">{item.tag}</code>
                              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{item.desc}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[10px] font-black text-slate-300 uppercase tracking-widest whitespace-nowrap overflow-x-auto no-scrollbar">
                  {modifiedCount > 0 && <span className="text-amber-600 bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-100 shadow-sm">{modifiedCount} Pending Changes</span>}
                  <span className="hidden sm:inline w-1 h-1 bg-slate-200 rounded-full"></span>
                  <span>{filteredRows.length} Localized Entries</span>
                </div>
              </div>

              <div style={{ height: "100%" }} className="flex-1 overflow-auto p-4 lg:p-12">
                {filteredRows.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center p-12 text-center">
                    <div className="w-24 h-24 bg-white rounded-[3rem] mb-6 flex items-center justify-center border border-slate-100 text-slate-100 shadow-sm">
                      <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                    </div>
                    {
                      activeProject.rows.length > 0
                        ? <div>
                          <p className="text-slate-400 font-black text-2xl uppercase italic tracking-tighter">No Search Results</p>
                          <p className="text-sm text-slate-300 mt-2 font-bold max-w-xs leading-relaxed">Try different search terms.</p>
                        </div>
                        : <div>
                          <p className="text-slate-400 font-black text-2xl uppercase italic tracking-tighter">Manifest Empty</p>
                          <p className="text-sm text-slate-300 mt-2 font-bold max-w-xs leading-relaxed">Fetch files from your repository to start real-time localization.</p>
                        </div>
                    }
                  </div>
                ) : (
                  <div style={{ height: "100%" }} className="space-y-6 lg:space-y-0 lg:bg-white lg:border lg:border-slate-200 lg:rounded-[3rem] lg:shadow-sm lg:overflow-hidden min-w-full">
                    {/* Header for Desktop */}
                    <div className="hidden lg:grid grid-cols-[320px_1fr_1fr_1fr] bg-white border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-widest p-8 sticky top-0 z-10 bg-white/95 backdrop-blur-sm">
                      <div>ENTRY PATH</div>
                      <div>SOURCE STRING</div>
                      <div>TARGET LOCALE</div>
                      <div>AI SUGGESTION</div>
                    </div>

                    <div style={{ height: "100%" }} className="divide-y divide-slate-100 space-y-6 lg:space-y-0">
                      <Virtuoso
                        style={{ height: "100%" }}
                        data={filteredRows}
                        itemContent={(_, row) => (
                          <div key={row.key} className={`bg-white rounded-3xl lg:rounded-none border lg:border-none shadow-xl shadow-slate-900/5 lg:shadow-none p-6 lg:p-10 flex flex-col lg:grid lg:grid-cols-[320px_1fr_1fr_1fr] gap-6 lg:gap-12 items-start transition-all ${row.targetValue !== row.originalTargetValue ? 'bg-amber-50/10 lg:bg-amber-50/10 border-amber-100' : 'hover:bg-slate-50/20'}`}>
                            {/* Key Column */}
                            <div className="w-full lg:w-auto overflow-hidden">
                              <label className="lg:hidden text-[9px] font-black text-slate-400 uppercase mb-3 block tracking-widest">Entry Path</label>
                              <div className="text-[10px] lg:text-[11px] font-mono text-slate-400 break-all leading-relaxed font-bold tracking-tighter bg-slate-50 p-4 lg:bg-transparent lg:p-0 rounded-2xl border lg:border-none border-slate-100">{row.key}</div>
                            </div>

                            {/* Source Column */}
                            <div className="w-full">
                              <label className="lg:hidden text-[9px] font-black text-indigo-400 uppercase mb-3 block tracking-widest">Source String</label>
                              <div className="text-sm lg:text-sm p-5 lg:p-7 bg-slate-50/50 rounded-2xl lg:rounded-[2.5rem] border border-slate-100/50 whitespace-pre-wrap text-slate-700 leading-relaxed font-black shadow-inner">{row.sourceValue}</div>
                            </div>

                            {/* Target Column */}
                            <div className="w-full relative">
                              <label className="lg:hidden text-[9px] font-black text-emerald-500 uppercase mb-3 block tracking-widest">Target Locale</label>
                              <textarea
                                className={`w-full text-sm lg:text-sm p-5 lg:p-7 rounded-2xl lg:rounded-[2.5rem] border outline-none transition-all min-h-[120px] lg:min-h-[160px] leading-relaxed font-black ${row.targetValue !== row.originalTargetValue ? 'border-amber-300 ring-8 ring-amber-500/5 bg-white shadow-2xl' : 'border-slate-100 bg-white focus:ring-8 focus:ring-indigo-500/5 shadow-sm'}`}
                                value={row.targetValue}
                                style={{ resize: 'none' }}
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
                                <span className="absolute -top-3 -right-3 bg-amber-500 text-[9px] lg:text-[10px] font-black text-white px-4 py-1.5 rounded-full border-4 border-white uppercase shadow-2xl">Modified</span>
                              )}
                            </div>

                            {/* AI Column */}
                            <div className="w-full relative group">
                              <label className="lg:hidden text-[9px] font-black text-purple-500 uppercase mb-3 block tracking-widest">AI Suggestion</label>
                              <div
                                className={`text-sm lg:text-sm p-5 lg:p-7 rounded-2xl lg:rounded-[2.5rem] min-h-[120px] lg:min-h-[160px] whitespace-pre-wrap transition-all leading-relaxed font-bold ${row.aiSuggestion && !rowAiLoading[row.key]
                                  ? 'bg-indigo-50/50 border border-indigo-100 text-indigo-900 italic shadow-xl shadow-indigo-500/10'
                                  : rowAiTemp[row.key] && rowAiLoading[row.key]
                                    ? 'bg-slate-50/50 border border-slate-100 text-indigo-900 italic shadow-xl shadow-slate-500/10'
                                    : 'bg-slate-50/30 border border-dashed border-slate-200 text-slate-200 flex items-center justify-center font-black text-[10px] uppercase tracking-widest opacity-50'}`}
                              >
                                {row.aiSuggestion && !rowAiLoading[row.key] ? row.aiSuggestion : (rowAiTemp[row.key] && rowAiLoading[row.key] ? <div>{row.aiSuggestion || rowAiTemp[row.key]}<div className="w-2 h-2 centered relative">
                                  <div className="absolute inset-0 border-[8px] border-indigo-50 rounded-full"></div>
                                  <div className="absolute inset-0 border-[8px] border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                                </div></div> : (rowAiLoading[row.key] ?
                                  <div>Awaiting AI<div className="w-10 h-10 centered relative">
                                    <div className="absolute inset-0 border-[8px] border-indigo-50 rounded-full"></div>
                                    <div className="absolute inset-0 border-[8px] border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                                  </div></div> : "No AI"))}
                              </div>
                              {row.aiSuggestion && !rowAiLoading[row.key] ? (
                                <div>
                                  <button
                                    onClick={() => {
                                      const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, aiSuggestion: "" } : r);
                                      updateActiveProject({ rows: newRows });
                                    }}
                                    className="absolute top-3 right-20 lg:top-6 lg:right-17 bg-white text-rose-600 font-black p-2 lg:p-3 rounded-2xl shadow-2xl opacity-80 lg:opacity-0 lg:group-hover:opacity-80 transition-all border border-rose-50 active:scale-75 hover:bg-rose-50"
                                  >
                                    <svg className="w-4 h-4 lg:w-5 lg:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18 18 6M6 6l12 12" /></svg>
                                  </button>
                                  <button
                                    onClick={() => {
                                      const newRows = activeProject.rows.map(r => r.key === row.key ? { ...r, targetValue: row.aiSuggestion || r.targetValue } : r);
                                      updateActiveProject({ rows: newRows });
                                    }}
                                    className="absolute top-3 right-3 lg:top-6 lg:right-6 bg-white text-lime-600 p-3 lg:p-4 rounded-2xl shadow-2xl opacity-80 lg:opacity-0 lg:group-hover:opacity-80 transition-all border border-lime-50 active:scale-75 hover:bg-lime-50"
                                  >
                                    <svg className="w-6 h-6 lg:w-7 lg:h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
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
                                        [{ key: row.key, value: row.sourceValue }]
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
                                  className="absolute top-3 right-3 lg:top-6 lg:right-6 bg-indigo-600 text-white p-3 lg:p-4 rounded-2xl shadow-2xl opacity-100 lg:opacity-0 lg:group-hover:opacity-100 font-black transition-all border border-indigo-50 active:scale-75 hover:bg-indigo-700"
                                >
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      />

                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Mobile Header Toggle */}
        <button
          onClick={() => setIsSidebarOpen(true)}
          className="lg:hidden absolute top-6 left-6 p-2.5 bg-white rounded-2xl shadow-xl z-30 border border-slate-200"
        >
          <svg className="w-6 h-6 text-slate-900" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 12h16m-7 6h7" /></svg>
        </button>

        {/* Global Settings Dialog */}
        {showSettings && (
          <div className="fixed inset-0 bg-slate-900/85 backdrop-blur-2xl z-[100] flex items-center justify-center p-6 lg:p-12">
            <div className="bg-white w-full max-w-2xl rounded-[3rem] lg:rounded-[4.5rem] shadow-[0_64px_256px_-64px_rgba(0,0,0,0.7)] overflow-hidden animate-in zoom-in-95 duration-500 max-h-[95vh] overflow-y-auto">
              <div className="p-10 lg:p-20">
                <div className="flex justify-between items-center mb-12 lg:mb-16">
                  <div>
                    <h2 className="text-4xl lg:text-5xl font-black text-slate-900 tracking-tighter">Global Config</h2>
                    <p className="text-[11px] text-slate-400 font-black uppercase tracking-[0.4em] mt-4">Local Memory Sync</p>
                  </div>
                  <button onClick={() => setShowSettings(false)} className="p-5 bg-slate-50 text-slate-400 hover:text-slate-900 rounded-full transition-all active:scale-75 shadow-sm">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="space-y-12 lg:space-y-16">
                  <section>
                    <div className="flex items-center gap-4 mb-6">
                      <div className="w-2.5 h-10 bg-indigo-500 rounded-full"></div>
                      <label className="text-[12px] font-black text-slate-500 uppercase tracking-widest">GitHub Auth Token</label>
                    </div>
                    <input
                      type="password"
                      placeholder="**************************************"
                      className="w-full p-6 lg:p-8 bg-slate-50 border border-slate-100 rounded-[2.5rem] text-sm outline-none font-mono tracking-widest focus:ring-[16px] focus:ring-indigo-500/5 transition-all shadow-inner"
                      value={settings.githubToken}
                      onChange={e => setSettings({ ...settings, githubToken: e.target.value })}
                    />
                    <p className="mt-5 px-6 text-[11px] text-slate-400 font-bold leading-relaxed opacity-70 italic">
                      Manifest Encryption: Tokens are stored exclusively in your browser's private localStorage. We never route keys through proxy servers.
                    </p>
                  </section>

                  <section>
                    <div className="flex items-center gap-4 mb-6">
                      <div className="w-2.5 h-10 bg-indigo-500 rounded-full"></div>
                      <label className="text-[12px] font-black text-slate-500 uppercase tracking-widest">Gemini API Key</label>
                    </div>
                    <input
                      type="password"
                      placeholder="**************************************"
                      className="w-full p-6 lg:p-8 bg-slate-50 border border-slate-100 rounded-[2.5rem] text-sm outline-none font-mono tracking-widest focus:ring-[16px] focus:ring-indigo-500/5 transition-all shadow-inner"
                      value={settings.geminiApiKey}
                      onChange={e => setSettings({ ...settings, geminiApiKey: e.target.value })}
                    />
                    <p className="mt-5 px-6 text-[11px] text-slate-400 font-bold leading-relaxed opacity-70 italic">
                      Manifest Encryption: Tokens are stored exclusively in your browser's private localStorage. We never route keys through proxy servers.
                    </p>
                  </section>

                  <section>
                    <div className="flex items-center gap-4 mb-6">
                      <div className="w-2.5 h-10 bg-indigo-500 rounded-full"></div>
                      <label className="text-[12px] font-black text-slate-500 uppercase tracking-widest">AI Suggestion Chunk Size: {settings.suggestionChunkSize}</label>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      className="w-full p-6 lg:p-8 bg-slate-50 border border-slate-100 rounded-[2.5rem] text-sm outline-none font-mono tracking-widest focus:ring-[16px] focus:ring-indigo-500/5 transition-all shadow-inner range-lg cursor-pointer"
                      value={settings.suggestionChunkSize}
                      onChange={e => setSettings({ ...settings, suggestionChunkSize: parseInt(e.target.value) })}
                    />
                  </section>
                </div>

                <div className="mt-16 lg:mt-20 pt-12 border-t border-slate-100">
                  <button
                    onClick={() => setShowSettings(false)}
                    className="w-full py-7 bg-slate-900 text-white rounded-[2.5rem] lg:rounded-[3rem] font-black uppercase tracking-widest text-[11px] active:scale-95 transition-all shadow-3xl shadow-slate-900/20"
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
          <div className="fixed inset-0 bg-slate-900/85 backdrop-blur-2xl z-[100] flex items-center justify-center p-6 lg:p-12">
            <div className="bg-white w-full max-w-2xl rounded-[3rem] lg:rounded-[4.5rem] shadow-[0_64px_256px_-64px_rgba(0,0,0,0.7)] overflow-hidden animate-in zoom-in-95 duration-500 max-h-[95vh] overflow-y-auto">
              <div className="p-10 lg:p-20 bg-indigo-50">
                <div className="flex justify-between items-center mb-12 lg:mb-16">
                  <div>
                    <h2 className="text-4xl lg:text-5xl font-black text-slate-900 tracking-tighter">AI Suggest</h2>
                    <p className="text-[11px] text-slate-400 font-black uppercase tracking-[0.4em] mt-4">for all of current filtered rows</p>
                  </div>
                  <button onClick={() => setShowDialogSuggestAll(false)} className="p-5 bg-slate-50 text-slate-400 hover:text-slate-900 rounded-full transition-all active:scale-75 shadow-sm">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>

                <div className="space-y-12 lg:space-y-16">
                  <section>
                    <div className="flex items-center gap-4 mb-6">
                      <div className="w-2.5 h-10 bg-indigo-500 rounded-full"></div>
                      <label className="text-[12px] font-black text-slate-500 uppercase tracking-widest">Additional Instructions</label>
                    </div>
                    <input
                      type="text"
                      placeholder="e.g. Use formal language, local idioms, etc."
                      className="w-full p-6 lg:p-8 bg-slate-50 border border-slate-100 rounded-[2.5rem] text-sm outline-none font-mono tracking-widest focus:ring-[16px] focus:ring-indigo-500/5 transition-all shadow-inner"
                      value={additionalInstructions}
                      onChange={e => setAdditionalInstructions(e.target.value)}
                    />
                  </section>
                  <section>
                    <button
                      className={`w-full p-3 lg:p-4 ${replaceExistAISuggestions ? "text-amber-600 shadow-inner" : "text-slate-400 drop-shadow-lg"} bg-amber-50 hover:bg-amber-100 shadow-slate-500/20 border border-amber-100 rounded-[2.5rem] text-sm outline-none font-mono tracking-widest focus:ring-[16px] focus:ring-indigo-500/5 transition-all cursor-pointer items-center justify-item-start flex gap-3`}
                      onClick={() => setReplaceExistAISuggestions(!replaceExistAISuggestions)}
                    >
                      <div className="w-6 h-6 lg:w-7 lg:h-7 items-center justify-center rounded-[0.5rem] bg-auto outline-dashed outline-2">
                        {replaceExistAISuggestions && <svg className="w-6 h-6 lg:w-7 lg:h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <div className="text-[12px] font-black uppercase tracking-widest">Replace Existing AI Suggestions</div>
                    </button>
                  </section>
                </div>

                <div className="mt-16 lg:mt-20 pt-12 border-t border-slate-100">
                  <button
                    onClick={() => {
                      setShowDialogSuggestAll(false);
                      handleSuggestAll();
                    }}
                    className="w-full py-7 bg-indigo-900 text-white rounded-[2.5rem] lg:rounded-[3rem] font-black uppercase tracking-widest text-[11px] active:scale-95 transition-all shadow-3xl shadow-indigo-900/20"
                  >
                    Confirm & AI Suggest
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 bg-white/75 backdrop-blur-3xl z-[200] flex items-center justify-center animate-in fade-in duration-700">
            <div className="flex flex-col items-center gap-10 bg-white p-20 lg:p-28 rounded-[4.5rem] lg:rounded-[6rem] shadow-[0_128px_256px_-64px_rgba(0,0,0,0.25)] border border-slate-50 relative overflow-hidden group">
              <div className="w-24 h-24 lg:w-32 lg:h-32 relative">
                <div className="absolute inset-0 border-[8px] border-indigo-50 rounded-full"></div>
                <div className="absolute inset-0 border-[8px] border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
              </div>
              <div className="text-center">
                <p className="font-black text-2xl lg:text-4xl text-slate-900 tracking-tighter italic scale-110">Synthesizing...</p>
                <p className="text-[10px] text-slate-400 mt-5 uppercase tracking-[0.5em] font-black opacity-60">Synchronizing timeline data</p>
              </div>
            </div>
          </div>
        )}
      </main>
      <style>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
};

export default App;
