export const my = {
  brand: 'Kinetix Studio',
  nav: {
    projects: 'ပရောဂျက်များ',
    workbench: 'အလုပ်ခန်း',
    settings: 'ဆက်တင်နှင့် အသံများ',
    environment: 'ဆာဗာအခြေအနေ',
    newProject: 'ပရောဂျက်အသစ်',
  },
  errors: {
    ffmpegNotFound: 'ffmpeg မတွေ့ပါ။ ဆာဗာမှာ ffmpeg ထည့်သွင်းရန် လိုပါတယ်။',
    notEnoughDisk: 'ဒစ်ခ်နေရာ မလောက်ပါ။ ဗီဒီယိုအရွယ်အစားရဲ့ ၃ ဆလောက် လိုပါတယ်။',
    missingGeminiKey: 'Gemini API key မရှိပါ။ .env.local ဖိုင် သို့မဟုတ် environment ထဲတွင် GEMINI_API_KEY ထည့်ပါ။',
    missingGeminiKeyAiStudio: 'Gemini API key မရှိပါ။ .env.local ဖိုင် သို့မဟုတ် environment ထဲတွင် GEMINI_API_KEY ထည့်ပါ။',
    uploadInterrupted: 'တင်တာ ပြတ်သွားပါတယ်။ ပြန်နှိပ်ရင် ဆက်တင်ပါမယ်။',
    invalidGeminiKey: 'Gemini API key မမှန်ကန်ပါ။ .env.local သို့မဟုတ် environment ထဲတွင် စစ်ဆေးပါ။',
    genericFailed: 'လုပ်ဆောင်ချက် မအောင်မြင်ပါ။',
    serverStartingRetry: 'ဆာဗာ စတင်နေပါတယ်၊ ပြန်ကြိုးစားနေပါတယ်...',
    serverStartupFailed: 'ဆာဗာ စတင်၍ မရပါ။ /api/health မှ အတည်ပြုချက် မရရှိပါ။',
    retryHealthBtn: 'ပြန်စစ်မယ်',
    serverLogsTitle: 'နောက်ဆုံး ဆာဗာ Error မှတ်တမ်းများ:',
    geminiQuotaExceeded: 'Gemini TTS quota ပြည့်သွားပါပြီ (429 RATE LIMIT)။ ခဏစောင့်ပြီး ပြန်နှိပ်ပါ — ပြီးပြီးသား အပိုင်းများကို cache ထဲမှ ပြန်သုံးပေးပါမည်။',
  },
  projects: {
    title: 'ဘာသာပြန်/အကျဉ်းချုပ် ပရောဂျက်များ',
    subtitle: 'ပရောဂျက်တစ်ခုလျှင် ဗီဒီယိုတစ်ဖိုင်နှုန်းဖြင့် ဒစ်ခ်ပေါ်တွင် သိမ်းဆည်းထားပြီး ပြန်စနိုင်ပါသည်။',
    newProjectBtn: 'ပရောဂျက်အသစ်',
    createTitle: 'ပရောဂျက်အသစ် ဖန်တီးရန်',
    cancel: 'ပယ်ဖျက်မယ်',
    projectTitleLabel: 'ပရောဂျက်အမည်',
    projectTitlePlaceholder: 'ဥပမာ - အပိုင်း ၁ မြန်မာအသံထပ်',
    defaultTitlePrefix: 'ပရောဂျက်',
    modeLabel: 'အသုံးပြုမည့် ပုံစံ',
    modeDubbingShort: 'Dubbing (-c:v copy)',
    modeRecapShort: 'Recap (480p CFR)',
    outputLangLabel: 'ထုတ်ပေးမည့် အသံဘာသာစကား',
    langMy: 'မြန်မာ (my-MM)',
    langEn: 'English (en-US)',
    langBoth: '၂ မျိုးလုံး',
    creating: 'ဖန်တီးနေသည်...',
    createSubmit: 'ဖန်တီးပြီး အလုပ်ခန်းဖွင့်မယ်',
    loadingList: 'ဒစ်ခ်ပေါ်မှ ပရောဂျက်များကို ဖတ်နေသည်...',
    emptyTitle: 'ပရောဂျက် မရှိသေးပါ',
    emptyDesc: '၁ မိနစ်မှ ၂ နာရီအထိ ဗီဒီယိုတစ်ခုကို 8 MB အပိုင်းများဖြင့် တင်ပြီး အဆင့် ၁ စစ်ဆေးမှု စတင်ရန် ပရောဂျက်အသစ် ဖန်တီးပါ။',
    createFirstBtn: 'ပထမဆုံး ပရောဂျက် ဖန်တီးမယ်',
    colProject: 'ပရောဂျက်',
    colMode: 'ပုံစံ / ဘာသာစကား',
    colMedia: 'မူရင်း ဗီဒီယို',
    colProgress: 'အဆင့် ၁ အခြေအနေ',
    colActions: 'လုပ်ဆောင်ချက်',
    uploadingLabel: 'တင်နေသည်',
    noVideoUploaded: 'ဗီဒီယို မတင်ရသေးပါ',
    openBtn: 'ဖွင့်မယ်',
    deleteAria: 'ပရောဂျက် ဖျက်မယ်',
    stage1DoneLabel: 'ပြီးပါပြီ',
    stage1PendingLabel: 'စောင့်ဆိုင်းနေ',
    noDialogue: 'စကားပြောမပါ',
  },
  workbench: {
    noVideo: 'ဗီဒီယို မတင်ရသေးပါ',
    modeDubbing: 'Dubbing ပုံစံ',
    modeRecap: 'Recap ပုံစံ',
    langMy: 'my-MM',
    langEn: 'en-US',
    langBoth: 'my-MM + en-US',
    vStartLabel: 'v_start',
    aStartLabel: 'a_start',
    offsetLabel: 'ကွာဟချက်',
    guideTitle: 'လမ်းညွှန် - အဆင့် ၁',
    guideSteps: [
      '၁။ "ဗီဒီယိုရွေးမယ်" ကိုနှိပ်ပြီး ဗီဒီယိုတစ်ခု ရွေးပါ။ စမ်းသပ်ရင် ၁-၂ မိနစ်ပဲ ရွေးပါ။',
      '၂။ တင်နေစဉ် အရောင်ဘားနဲ့ ရာခိုင်နှုန်း ပြပါမယ်။ ပြတ်သွားရင် ပြန်နှိပ်ပါ၊ ကျန်တာကို ဆက်တင်ပါမယ်။',
      '၃။ တင်ပြီးရင် ဗီဒီယိုကို စစ်ဆေးပါမယ် (ကြာချိန်၊ fps၊ အရွယ်အစား၊ အသံပါ/မပါ)။',
      '၄။ အသံဖိုင် ၂ ခု ထုတ်ပါမယ်: AI အတွက် (16 kHz) နဲ့ အသံရောစပ်ဖို့ (48 kHz)။',
      '၅။ အားလုံးပြီးရင် "ပြီးပါပြီ" လို့ ပြပါမယ်။ မပြီးရင် အနီရောင်နဲ့ error စာ ပြပါမယ်။',
    ],
    uploadCardTitle: 'S0. 8 MB အပိုင်းများဖြင့် ဗီဒီယိုတင်ခြင်း',
    uploadCardDesc: 'ဘရောက်ဇာမှ ဗီဒီယိုကို {chunkSize} အပိုင်းများခွဲ၍ ဆာဗာသို့ တိုက်ရိုက်တင်ပေးပါမည်။ မတင်မီ ဒစ်ခ်နေရာ ၃ ဆ ရှိ/မရှိ စစ်ဆေးပါမည်။',
    pauseUploadBtn: 'ခဏရပ်မယ်',
    selectVideoBtn: 'ဗီဒီယိုရွေးမယ်',
    resumeVideoBtn: 'ဆက်တင်မယ် ({filename})',
    partialSavedPrefix: 'တစ်ပိုင်းတစ်စ သိမ်းထားပြီးပါပြီ',
    chunksUnit: 'အပိုင်း',
    reselectHint: 'ကျန်တာကို ဆက်တင်ရန် ထိုဖိုင်ကိုပဲ ပြန်ရွေးပါ။',
    chunkLabel: 'အပိုင်း',
    stage1Header: 'အဆင့် ၁ နှင့် ၂ · စစ်ဆေးမှု၊ စကားပြောမြေပုံ၊ စကားပြောသူနှင့် မြင်ကွင်းခွဲခြမ်းစိတ်ဖြာမှု',
    stage1DefaultLog: 'ဖိုင်တွဲ data/projects/{id}/project.json တွင် အလိုအလျောက် သိမ်းဆည်းထားပါသည်။',
    processingIngest: 'ခွဲခြမ်းစိတ်ဖြာနေသည် (S0–S3)...',
    doneBtn: 'ပြီးပါပြီ',
    verifyIngestBtn: 'စစ်ဆေးပြီး S1–S3 ခွဲခြမ်းစိတ်ဖြာမယ်',
    rerunBtn: 'အစမှ ပြန်စမယ်',
    s0Title: 'S0. စစ်ဆေးမှုနှင့် WAV ဖိုင်များ',
    s1Title: 'S1. စကားပြောမြေပုံ',
    s2Title: 'S2. စကားပြောသူနှင့် ကျား/မ',
    s3Title: 'S3. တိတ်ဆိတ်မှုနှင့် မြင်ကွင်းဖြတ်တောက်မှု',
    stage2Tag: 'အဆင့် ၂',
    stage2Queued: 'ခွဲခြမ်းစိတ်ဖြာရန် အသင့်ဖြစ်နေသည်',
    statusDone: 'ပြီးပါပြီ',
    statusRunning: 'လုပ်ဆောင်နေသည်',
    statusError: 'အမှားတွေ့',
    statusPending: 'စောင့်ဆိုင်းနေ',
    previewProxyTitle: '480p CFR Proxy အစမ်းကြည့်ရှုမှု (Recap ပုံစံ)',
    previewSourceTitle: 'မူရင်းဗီဒီယို အစမ်းကြည့်ရှုမှု (Dubbing -c:v copy)',
    back5s: '၅ စက္ကန့် နောက်ဆုတ်',
    forward5s: '၅ စက္ကန့် ရှေ့တိုး',
    play: 'ဖွင့်မယ်',
    pause: 'ရပ်မယ်',
    extractedAudioTitle: 'ထုတ်ယူထားသော အသံဖိုင်များနှင့် အချက်အလက်',
    audio16kTitle: '16 kHz Mono WAV (AI အတွက်)',
    audio48kTitle: '48 kHz Stereo WAV (အသံရောစပ်ဖို့)',
    noAudioNotice: 'ဤဗီဒီယိုတွင် အသံလမ်းကြောင်း မပါဝင်ပါ (has_audio: false)။ စကားပြောမပါဟု မှတ်သားထားပါသည်။',
    noDialogueBanner: 'စကားပြောမပါ (No dialogue) — စကားပြောကြာချိန်သည် ဗီဒီယိုစုစုပေါင်း၏ ၅% အောက်ဖြစ်သည် ({pct}%)။',
    metaFpsMode: 'fps / ပုံစံ',
    metaDuration: 'ကြာချိန် (ms)',
    metaStartTimes: 'v_start_ms / a_start_ms',
    metaProxy: '480p CFR proxy',
    proxyNotGenerated: 'မထုတ်ထားပါ (Dubbing)',
    tabTranscript: 'စာသားမှတ်တမ်း ({count})',
    tabSpeakers: 'စကားပြောသူနှင့် ကျား/မ ({count})',
    tabMaps: 'တိတ်ဆိတ်မှုနှင့် မြင်ကွင်း',
    tabJson: 'project.json (ဒစ်ခ်ပေါ်ရှိ အချက်အလက်)',
    copyJson: 'JSON ကူးမယ်',
    copiedJson: 'ကူးပြီးပါပြီ',
    shellTranscriptTitle: 'တည်းဖြတ်နိုင်သော စာသားမှတ်တမ်း (S1 Speech Map)',
    shellSpeakersTitle: 'စကားပြောသူများနှင့် ကျား/မ ခွဲခြားမှု (S2)',
    shellMapsTitle: 'တိတ်ဆိတ်မှုနှင့် မြင်ကွင်းဖြတ်တောက်မှု (S3)',
    shellDesc: 'အဆင့် ၂ (S1 စကားပြောမြေပုံ၊ S2 စကားပြောသူနှင့် ကျား/မ၊ S3 တိတ်ဆိတ်မှု/မြင်ကွင်း) ကို စတင်ရန် "စစ်ဆေးပြီး S1–S3 ခွဲခြမ်းစိတ်ဖြာမယ်" ခလုတ်ကို နှိပ်ပါ။',
    colId: '#',
    colTimeRange: 'အချိန် (start–end ms)',
    colDuration: 'ကြာချိန်',
    colSpeaker: 'စကားပြောသူ',
    colLang: 'ဘာသာ',
    colText: 'စာသား (တည်းဖြတ်နိုင်)',
    colActions: 'သိမ်းမယ်',
    saveRowBtn: 'သိမ်းမယ်',
    savingRowBtn: 'သိမ်းနေ...',
    savedRowBadge: 'သိမ်းပြီး',
    emptyTranscript: 'စာသားမှတ်တမ်း မရှိသေးပါ။ ခွဲခြမ်းစိတ်ဖြာမှုကို စတင်ပါ သို့မဟုတ် စကားပြောမပါ (no dialogue) ဖြစ်နိုင်ပါသည်။',
    colSpeakerId: 'စကားပြောသူ ID',
    colMergedFrom: 'ပေါင်းစည်းထားသော Label',
    colUtterances: 'အကြိမ် / ကြာချိန်',
    colSampleAudio: 'အသံနမူနာ (၂၀-၃၀ စက္ကန့်)',
    colGenderSelect: 'ကျား/မ (တည်းဖြတ်နိုင်)',
    colConfidence: 'ယုံကြည်မှု',
    genderMale: 'အမျိုးသား (male)',
    genderFemale: 'အမျိုးသမီး (female)',
    genderUnknown: 'မသိ (unknown)',
    noSampleFile: 'နမူနာဖိုင် မရှိပါ',
    emptySpeakers: 'စကားပြောသူ မတွေ့သေးပါ။',
    silenceSummaryTitle: 'S3 တိတ်ဆိတ်မှု အပိုင်းများ (silencedetect)',
    sceneCutsSummaryTitle: 'S3 မြင်ကွင်းပြောင်းလဲမှု အမှတ်များ (scene cuts)',
    silenceCountLabel: 'တိတ်ဆိတ်မှု အပိုင်းအရေအတွက်',
    sceneCountLabel: 'မြင်ကွင်းဖြတ် အရေအတွက်',
    speechCoverageLabel: 'စကားပြော ပါဝင်နှုန်း',
    seekBtnTitle: 'ဗီဒီယိုကို ဤနေရာသို့ ရွှေ့မယ်',
    emptyMaps: 'တိတ်ဆိတ်မှုနှင့် မြင်ကွင်းအချက်အလက် မရှိသေးပါ။',
    dubStageCardTitle: 'အဆင့် ၃ · အသံထပ်ခြင်း (TTS)',
    tabDubbing: 'အသံထပ်ခြင်း (Dubbing · {count})',
    modelUsedPrefix: 'အသုံးပြုထားသော မော်ဒယ်',
    recapAudioToggleBtn: 'မူရင်းအသံ ဖွင့်/ပိတ် (Original Audio On/Off)',
    recapAudioMuted: 'မူရင်းအသံ: ပိတ်ထားသည် (Original Audio Off)',
    recapAudioOn: 'မူရင်းအသံ: ဖွင့်ထားသည် (Original Audio On)',
    chunksTitle: 'ဗီဒီယိုရှည် စမတ်အပိုင်းခွဲစနစ် (Smart Chunks · ၃–၁၀ မိနစ်)',
    chunksSubtitle: '၁၀ မိနစ်ကျော် ဗီဒီယိုများကို စကားပြောအလယ်တွင် မဖြတ်ဘဲ ၃–၁၀ မိနစ် အပိုင်းများခွဲ၍ cache/chunks/ ထဲတွင် သိမ်းဆည်းလုပ်ဆောင်ပြီး ပြန်ပေါင်းပေးပါမည်။',
    chunksRunBtn: 'အပိုင်းခွဲပြီး အပြည့်ထုတ်မယ် (Chunked Run)',
    chunksResumeBtn: 'ကျန်အပိုင်းမှ ဆက်လုပ်မယ် (Resume Chunks)',
    chunksRunningBtn: 'အပိုင်းများ လုပ်ဆောင်နေသည်...',
    chunksDoneLabel: 'ပြီးပြီ',
    chunksPendingLabel: 'စောင့်နေ',
    chunksErrorLabel: 'အမှား',
    resumeFailedBtn: 'ပြန်ဆက်လုပ်မယ် (Resume)',
    dualSubModeHint: 'မြန်မာအသံ + အင်္ဂလိပ်စာတန်းထိုး (MY Audio + English SRT)',
  },
  dubbing: {
    title: 'အဆင့် ၃ · ဘာသာပြန် အသံထပ်ခြင်း (Dubbing MVP)',
    subtitle: 'ရွေးထားသော အပိုင်းများကို ဆက်တင်ထဲရှိ TTS အင်ဂျင်နှင့် မော်ဒယ်များဖြင့် တစ်ခုချင်းစီ အသံထုတ်ပြီး cache သိမ်းပေးပါမည်။',
    duckingNotice: 'စကားသံသာ ဖယ်ထားသည် (BGM/SFX ကျန်)',
    stepCSettingsTitle: 'Step C · အသံအင်ဂျင်နှင့် မော်ဒယ် ဆက်တင်များ (Settings နှင့် ချိတ်ဆက်)',
    ttsVolumeLabel: 'TTS အသံအတိုးအကျယ်',
    savingSettingsBtn: 'ဆက်တင် သိမ်းနေ...',
    selectionLabel: 'လုပ်ဆောင်မည့် အပိုင်းများ (Segments to process)',
    modeFirstN: 'ပထမ N ပိုင်း (စမ်းသပ်)',
    modeRange: 'အပိုင်း အစ–အဆုံး (Range)',
    modeAll: 'အားလုံး (ဗီဒီယို အပြည့်)',
    firstNCountLabel: 'အရေအတွက်:',
    rangeStartLabel: 'မှ (#):',
    rangeEndLabel: 'ထိ (#):',
    selectionTestClipHint: 'စမ်းသပ်ဗီဒီယို (Test Clip): ရွေးထားသော {count}/{total} ပိုင်း ({start} – {end}) ကိုသာ ထုတ်ပေးမည်။',
    selectionFullVideoHint: 'ဗီဒီယိုအပြည့် (Full Video): စုစုပေါင်း {total} ပိုင်းလုံးကို ထုတ်ပေးမည်။',
    calibratedSpsLabel: 'လက်တွေ့ အသံနှုန်း (syllables/s):',
    etaLabel: 'ခန့်မှန်း ကျန်ချိန် (ETA):',
    secondsUnit: 'စက္ကန့်',
    translateBtn: '၁။ ဘာသာပြန် & အသံတွဲမယ်',
    translatingBtn: 'ဘာသာပြန်နေသည်...',
    renderBtn: '၂။ TTS အသံထပ် & ဗီဒီယိုထုတ်မယ်',
    renderingBtn: 'အသံထပ်နေသည်...',
    retranslateAllBtn: 'အသစ်ပြန်ဘာသာပြန်မယ်',
    voiceMapTitle: 'Step C · စကားပြောသူအလိုက် အသံတွဲမှု ({engine})',
    voiceMapEmpty: 'အဆင့် ၂ စကားပြောသူ ခွဲခြမ်းစိတ်ဖြာမှု မပြီးသေးပါ။',
    colSpeaker: 'စကားပြောသူ',
    colGender: 'ကျား/မ (ပြင်နိုင်)',
    colGeminiVoice: 'အသံ ({engine})',
    colVoiceForEngine: '{engine} အသံ',
    colPreview: 'စမ်းသပ်နားထောင်',
    previewVoiceBtn: 'အသံစမ်းမယ်',
    previewingVoiceBtn: 'ထုတ်နေ...',
    glossaryTitle: 'အခေါ်အဝေါ် ဝေါဟာရစာရင်း (Glossary)',
    cuesTableTitle: 'Step A–D · အသံထပ် စာသားနှင့် အချိန်ကိုက်ညှိမှု ဇယား',
    emptyCuesHint: 'စတင်ရန် "၁။ ဘာသာပြန် & အသံတွဲမယ်" သို့မဟုတ် "၂။ TTS အသံထပ် & ဗီဒီယိုထုတ်မယ်" ကိုနှိပ်ပါ။',
    langFilterLabel: 'ဘာသာစကား:',
    colLineId: '#',
    colSourceText: 'မူရင်းစာသား',
    colTranslationEdit: 'ဘာသာပြန်စာသား (တည်းဖြတ်နိုင်)',
    colSlotTts: 'slot_ms / tts_ms',
    colRate: 'နှုန်း (rate)',
    colStatus: 'အခြေအနေ',
    colAction: 'ပြန်ထုတ်မယ်',
    regenerateBtn: 'သိမ်း & ပြန်ထုတ်',
    regeneratingBtn: 'ထုတ်နေ...',
    retranslateCompleteBtn: 'ပိုပြည့်စုံအောင် ပြန်ဘာသာပြန်မယ်',
    retranslatingCompleteBtn: 'ပြန်ဘာသာပြန်နေ...',
    incompleteWarningPrefix: 'သတိပေးချက်',
    modelUsedLabel: 'မော်ဒယ်',
    lengthVsSlotLabel: 'အရှည် vs အချိန်ကွက်',
    videoRateLabel: 'ဗီဒီယိုနှုန်း',
    statusOk: 'ok',
    statusCompressed: 'compressed',
    statusRetranslated: 'retranslated',
    statusNeedsReview: 'needs_review',
    statusOverflow: 'overflow',
    outputTitle: 'Step F · အသံထပ်ပြီး ဗီဒီယို အစမ်းကြည့်ရှုမှုနှင့် ဒေါင်းလုဒ်',
    previewLangLabel: 'ကြည့်ရှုမည့် ဘာသာ:',
    downloadMp4: 'MP4 ဒေါင်းလုဒ်',
    downloadWav: 'WAV ဒေါင်းလုဒ်',
    downloadSrt: 'SRT ဒေါင်းလုဒ်',
    downloadEnglishSrt: 'Download English SRT',
    downloadDualMp4: 'Dual-Track MP4 ဒေါင်းလုဒ် (MY + EN)',
    qaTitle: 'Step H · အရည်အသွေး စစ်ဆေးချက် (Validation)',
    qaAvSyncLabel: '|A - V| ကွာဟချက်',
    qaPass40: 'PASS (≤ 40 ms)',
    qaFail40: 'CHECK (> 40 ms)',
    qaStatusSummaryLabel: 'လိုင်းအခြေအနေ အကျဉ်းချုပ်',
    qaFlaggedTitle: 'ပြန်စစ်ရန် လိုအပ်သော အပိုင်းများ (overflow / needs_review):',
    qaAllClean: 'overflow သို့မဟုတ် needs_review အပိုင်း မရှိပါ။',
  },
  environment: {
    title: 'ဆာဗာစနစ်နှင့် ပြင်ဆင်ချက်များ',
    subtitle: 'အဆင့် ၁ ဆာဗာ tool စစ်ဆေးမှု၊ Gemini မော်ဒယ်စာရင်း၊ rate limit နှင့် request အရေအတွက်။',
    loading: 'ဆာဗာ tool များ၊ Gemini မော်ဒယ်စာရင်းနှင့် ဒစ်ခ်နေရာကို စစ်ဆေးနေသည်...',
    recheckBtn: 'ပြန်စစ်မယ်',
    ffmpegCard: 'FFmpeg နှင့် FFprobe',
    operational: 'အဆင်သင့်ဖြစ် ({source})',
    unavailable: 'အသုံးမပြုနိုင်ပါ',
    geminiCard: 'Gemini Key နှင့် မော်ဒယ်စာရင်း',
    keyVerified: 'Key မှန်ကန်သည်',
    keyInvalid: 'Key မမှန်ပါ',
    keyMissing: 'Key မရှိပါ',
    catalogCount: 'မော်ဒယ်စာရင်း အရေအတွက်',
    optionalDemucs: 'Demucs (ရွေးချယ်နိုင်):',
    demucsFound: 'PATH တွင် တွေ့ရှိသည်',
    demucsMissing: 'မထည့်သွင်းထားပါ (ducking သုံးမည်)',
    diskCard: 'ဆာဗာ ဒစ်ခ်နေရာ',
    freeSuffix: 'လွတ်နေသည်',
    totalVolumePrefix: 'စုစုပေါင်း',
    diskRuleHint: 'ဗီဒီယိုတင်ရန် ၃ ဆနေရာ လိုသည်',
    dataDirLabel: 'ဒေတာသိမ်းဆည်းရာ ဖိုင်တွဲ (DATA_DIR)',
    configHeader: 'config.json မော်ဒယ်များ၊ Rate Limit နှင့် Request အရေအတွက်',
    configNote: 'ဆာဗာစတင်ချိန်တွင် ဖတ်သည်',
    apiText: 'Text API',
    apiTranscribe: 'Transcribe API',
    apiGeminiTts: 'Gemini TTS API',
    apiEdgeTts: 'Edge TTS API',
    requestsLabel: 'Request',
    chunkSizeLabel: 'အပိုင်းအရွယ်',
    maxWindowLabel: 'အများဆုံး အပိုင်း',
    silenceFilterLabel: 'တိတ်ဆိတ်မှု',
    sceneCutLabel: 'မြင်ကွင်းဖြတ်',
    gapRatioLabel: 'GAP_MS / RATIO',
    startupNotesTitle: 'ဆာဗာစတင်ချိန် မော်ဒယ်စစ်ဆေးမှု မှတ်တမ်း',
    localTitle: '၁-၂ နာရီ ဗီဒီယိုများအတွက် စက်ပေါ်တွင် အသုံးပြုနည်း',
    localDesc: 'စမ်းသပ်ရန် AI Studio Build တွင် ၁-၂ မိနစ် ဗီဒီယိုကို သုံးပါ။ ၁-၂ နာရီ ဗီဒီယိုကြီးများအတွက် ပရောဂျက်ကို ထုတ်ယူပြီး Mac/Linux ပေါ်တွင် ffmpeg နှင့် တွဲဖက်အသုံးပြုပါ:',
  },
  settings: {
    title: 'ဆက်တင်နှင့် အသံများ',
    subtitle: 'Gemini API key အခြေအနေ၊ မော်ဒယ်ရွေးချယ်မှု၊ TTS အင်ဂျင်နှင့် မူရင်း အမျိုးသမီး/အမျိုးသား အသံအုပ်စုများ။',
    saveConfigBtn: 'ဆက်တင်များ သိမ်းမယ်',
    savingConfigBtn: 'သိမ်းနေသည်...',
    savedNotice: 'config.json ထဲသို့ သိမ်းဆည်းပြီးပါပြီ။',
    apiKeyCardTitle: 'Gemini API Key အခြေအနေ (ကြည့်ရန်သာ)',
    apiKeyExistsLabel: 'ဆာဗာ environment (.env.local) ထဲတွင် GEMINI_API_KEY ရှိ/မရှိ',
    apiKeyYes: 'ရှိပါသည် (Yes)',
    apiKeyNo: 'မရှိပါ (No)',
    apiKeyHiddenHint: 'လုံခြုံရေးအတွက် key စာသားကို မည်သည့်အခါမျှ မပြသပါ။',
    modelsSectionTitle: 'Gemini မော်ဒယ် ရွေးချယ်မှု (config.json)',
    modelsSectionDesc: 'ဆာဗာရှိ Gemini မော်ဒယ်စာရင်းမှ ရွေးချယ်ပြီး config ထဲတွင် သိမ်းဆည်းပါ။',
    modelsUnavailableNotice: 'မော်ဒယ်စာရင်း မရရှိသေးပါ (သို့မဟုတ် key မရှိပါ)။',
    textModelLabel: 'TEXT_MODEL (ဘာသာပြန်နှင့် ဇာတ်ညွှန်း)',
    transcribeModelLabel: 'TRANSCRIBE_MODEL (စကားသံမှတ်တမ်း)',
    ttsModelLabel: 'TTS_MODEL (Gemini အသံထွက်)',
    speechStyleLabel: 'စကားပြောပုံစံ (Speech Style)',
    speechStylePolite: 'ယဉ်ကျေးသောပုံစံ (ပါတယ် / ရှင့် / ခင်ဗျာ)',
    speechStyleCasual: 'ပေါ့ပါးသော စကားပြောပုံစံ (တယ် / နော်)',
    ttsFallbacksLabel: 'TTS_FALLBACK_MODELS (Gemini TTS အရန်မော်ဒယ်များ)',
    textFallbacksLabel: 'TEXT_FALLBACK_MODELS (Text အရန်မော်ဒယ်များ)',
    ttsEngineTitle: 'TTS အသံထွက် အင်ဂျင်',
    ttsEngineDesc: 'အခမဲ့ Edge TTS (key မလို) သို့မဟုတ် Gemini TTS ကို ရွေးချယ်ပါ။',
    engineEdge: 'Edge TTS (key မလို)',
    engineGemini: 'Gemini TTS',
    edgeUnavailableBadge: 'ဤစနစ်ပတ်ဝန်းကျင်တွင် Edge TTS အသုံးမပြုနိုင်ပါ (Gemini TTS သို့ အလိုအလျောက် ပြောင်းထားသည်)',
    poolsTitle: 'မူရင်း အသံအုပ်စုများ ({engine})',
    poolsDesc: 'ဘာသာစကားတစ်ခုချင်းစီအတွက် အမျိုးသမီး (Female Pool) နှင့် အမျိုးသား (Male Pool) အသံများ သိမ်းဆည်းပါ။',
    langBurmeseTitle: 'မြန်မာ (my-MM)',
    langEnglishTitle: 'English (en-US)',
    femalePoolLabel: 'အမျိုးသမီး အသံအုပ်စု (Female Pool)',
    malePoolLabel: 'အမျိုးသား အသံအုပ်စု (Male Pool)',
    emptyPoolHint: 'အောက်ပါ အသံစာရင်းမှ ရွေးထည့်ပါ။',
    removeFromPoolAria: 'အုပ်စုမှ ဖယ်မယ်',
    voiceListEdgeTitle: 'Edge TTS အသံစာရင်း (my-MM နှင့် en-*)',
    voiceListGeminiTitle: 'Gemini TTS အသံ ၃၀ (Prebuilt Voices)',
    reloadVoicesBtn: 'အသံစာရင်း ပြန်ယူမယ်',
    loadingVoices: 'ဆာဗာမှ အသံစာရင်း ဖတ်နေသည်...',
    filterAllLocales: 'အားလုံး (my-MM + en-*)',
    filterMyLocale: 'my-MM',
    filterEnLocale: 'en-*',
    filterAllGender: 'ကျား/မ အားလုံး',
    filterFemale: 'အမျိုးသမီး (Female)',
    filterMale: 'အမျိုးသား (Male)',
    searchPlaceholder: 'အသံအမည် သို့မဟုတ် locale ရှာရန်...',
    sampleLangLabel: 'စမ်းသပ်မည့် ဘာသာစကား:',
    sampleMyLabel: 'မြန်မာ ("မင်္ဂလာပါ...")',
    sampleEnLabel: 'English ("Hello...")',
    colVoiceName: 'အသံအမည်',
    colGender: 'ကျား/မ',
    colLocaleStyle: 'Locale / ပုံစံ',
    colDefaultPools: 'မူရင်းအုပ်စုထဲ ထည့်ရန်',
    colPreview: 'နားထောင်ရန်',
    genderFemale: 'အမျိုးသမီး (Female)',
    genderMale: 'အမျိုးသား (Male)',
    geminiAllLocalesLabel: 'my-MM / en-US',
    addToMyPool: 'my-MM',
    addToEnPool: 'en-US',
    previewBtn: 'စမ်းသပ်မယ်',
    previewingBtn: 'ထုတ်နေသည်...',
    playingBanner: 'ဖွင့်နေသည်: {voice} ({lang})',
    stopPlaybackBtn: 'ရပ်မယ်',
    ttsErrorTitle: 'TTS အမှား (Exact Error)',
    emptyVoicesFilter: 'ရွေးထားသော စစ်ထုတ်မှုနှင့် ကိုက်ညီသော အသံ မတွေ့ပါ။',
    diagnosticOkTemplate: 'OK: {duration} s, {sizeKb} KB, engine={engine}, voice={voice}',
    downloadBtn: 'ဒေါင်းလုဒ် (Download)',
    selfTestBtn: 'TTS self-test',
    selfTestingBtn: 'TTS စစ်ဆေးနေသည်...',
    selfTestTitle: 'TTS self-test ရလဒ် (en-US-AriaNeural)',
  },
  persistence: {
    saveProjectBtn: 'သိမ်းမယ် (Save project)',
    savingZipLabel: 'ZIP ပြင်ဆင်နေသည်...',
    restoreProjectBtn: 'ပြန်ယူမယ် (Restore project)',
    restoringZipLabel: 'ZIP မှ ပြန်ယူနေသည်...',
    restoreFromBrowserBtn: 'ဒီဘရောက်ဇာကနေ ပြန်ယူမယ်',
    restoringBrowserLabel: 'ဘရောက်ဇာမှ ပြန်ယူနေသည်...',
    lastSavedLabel: 'နောက်ဆုံးသိမ်းချိန်',
    serverSavedLabel: 'ဆာဗာဒစ်ခ်',
    browserSavedLabel: 'ဘရောက်ဇာ (IndexedDB)',
    notSavedYet: 'မသိမ်းရသေးပါ',
    dataDirPrefix: 'DATA_DIR',
    includeSourceLabel: 'မူရင်းဗီဒီယို ထည့်မယ် (optional · {size})',
    includeSourceOverLimitHint: 'မူရင်းဖိုင် 200 MB ကျော်သောကြောင့် proxy ဗီဒီယို (480p) ကိုသာ ထည့်ပေးထားသည်',
    savedCardTitle: 'သိမ်းဆည်းထားသည့် အခြေအနေနှင့် Backup',
    savedSummaryLine:
      'project.json ({stages}) · စကားပြော {speechCount} · စကားပြောသူ {speakerCount} · ဘာသာပြန် {dubCount} · TTS အသံ {ttsCount} · {mediaStatus}',
    mediaOriginalAndProxy: 'မူရင်း + 480p proxy',
    mediaProxyOnly: '480p proxy သာ (မူရင်းမပါ)',
    mediaPending: 'ဗီဒီယိုမရှိသေးပါ',
    browserBannerTitle: 'ဒီဘရောက်ဇာ (IndexedDB) ထဲမှာ အလိုအလျောက် သိမ်းထားတဲ့ ပရောဂျက် {count} ခု တွေ့ရှိပါတယ်',
    browserBannerDesc:
      'ဆာဗာပြန်စချိန် DATA_DIR ထဲမှာ မတွေ့တော့သည့် ပရောဂျက်များကို API ထပ်မခေါ်ဘဲ ဘရောက်ဇာမှ တိုက်ရိုက် ပြန်ယူနိုင်ပါသည်။',
    restoreSuccessMsg: 'ပရောဂျက် "{title}" ({files} ဖိုင်) ကို ပြန်ယူပြီးပါပြီ။ ကျန်အဆင့်များကို API ထပ်မခေါ်ဘဲ ဆက်လုပ်နိုင်ပါသည်။',
    dismissBrowserBackup: 'ဖျက်မယ်',
  },
  wizard: {
    pipelineTitle: 'ပရောဂျက် ပိုက်လိုင်း',
    pipelineEmptyHint: 'စတင်ရန် ပရောဂျက် ဖန်တီးပါ သို့မဟုတ် ဖွင့်ပါ။',
    pipelineCardTitle: 'လုပ်ငန်းစဉ် ပိုက်လိုင်း',
    pipeAudioExtraction: 'အသံ ဖယ်ထုတ်ခြင်း',
    pipeVocalSeparation: 'Remote GPU အသံ ခွဲထုတ်ခြင်း',
    pipeQueued: 'စောင့်ဆဲ',
    pipeWaveVoice: 'အသံ Track (16 kHz)',
    pipeWaveMusic: 'Mix Bed (48 kHz)',
    resolutionUnknownLabel: 'Resolution စောင့်ဆဲ',
    step1Title: 'တင်ခြင်းနှင့် ပရောဂျက်',
    step1Sub: 'Upload & Project',
    step2Title: 'ခွဲခြမ်းစိတ်ဖြာမှု (S0–S3)',
    step2Sub: 'Ingest & Maps',
    step3Title: 'ပုံစံနှင့် အသံများ',
    step3Sub: 'Mode & Voices',
    step4Title: 'စတူဒီယို',
    step4Sub: 'Render Studio',
    step5Title: 'အစမ်းကြည့်နှင့် ထုတ်ယူ',
    step5Sub: 'Preview & Export',
    settingsBtn: 'ဆက်တင်',
    switchProjectBtn: 'ပရောဂျက်အားလုံး',
    allProjectsSectionTitle: 'သိမ်းဆည်းထားသော ပရောဂျက်များနှင့် Backup',
    manageProjectsShowBtn: 'သိမ်းထားသော ပရောဂျက်များ ကြည့်/ပြောင်းမယ် ({count})',
    manageProjectsHideBtn: 'ပရောဂျက်စာရင်း ခေါက်သိမ်းမယ်',
    activeProjectBanner: 'လက်ရှိ ပရောဂျက်',
    uploadedReadyTitle: 'ဗီဒီယို တင်ပြီးပါပြီ (S0 အသင့်ဖြစ်)',
    reuploadVideoBtn: 'ဗီဒီယိုအသစ် ပြန်တင်မယ်',
    selectVideoPrimaryBtn: 'ဗီဒီယိုရွေးပြီး တင်မယ်',
    chunkPreviewTitle: '၁၀ မိနစ်ကျော် Smart Chunk ကြိုတင်အစီအစဉ် ({count} ပိုင်း)',
    chunkPreviewDesc: '၃–၁၀ မိနစ်ကြား အပိုင်းများအဖြစ် တိတ်ဆိတ်မှု/မြင်ကွင်းဖြတ်မှတ်များအတိုင်း ခွဲပေးမည့် ကြိုတင်မြင်ကွင်း ဖြစ်ပါသည်။',
    chunkPreviewEstLabel: 'ကြိုတင်ခွဲပြချက်',
    nextStep2Btn: 'ရှေ့ဆက်မယ် · ခွဲခြမ်းစိတ်ဖြာမှု (S0–S3)',
    nextStep3Btn: 'ရှေ့ဆက်မယ် · ပုံစံနှင့် အသံများ',
    nextStep4Btn: 'ရှေ့ဆက်မယ် · စတူဒီယို',
    nextStep5Btn: 'ရှေ့ဆက်မယ် · အစမ်းကြည့်နှင့် ထုတ်ယူ',
    backToStudioBtn: 'စတူဒီယိုသို့ ပြန်သွားမယ်',
    startNewProjectBtn: 'ပရောဂျက်အသစ် စမယ်',
    inspectDataTitle: 'S0–S3 ရလဒ်များ စစ်ဆေးခြင်းနှင့် တည်းဖြတ်ခြင်း',
    tabMediaPreview: 'ဗီဒီယိုနှင့် ထုတ်ယူထားသော WAV',
    modeSectionTitle: '၁။ အသုံးပြုမည့် ပုံစံ ရွေးချယ်ပါ',
    modeDubbingDesc: 'မူရင်းစကားသံကို ဖယ်ပြီး BGM/SFX ချန်ထားကာ ဘာသာပြန်အသံဖြင့် အစားထိုးထုတ်ပေးပါမည်။',
    modeRecapDesc: 'ဇာတ်လမ်းအကျဉ်းချုပ် ဇာတ်ညွှန်းနှင့် နောက်ခံပြောသံအတွက် 480p CFR proxy ပြင်ဆင်ပေးပါမည်။',
    targetLangSectionTitle: '၂။ ထုတ်ပေးမည့် ဘာသာစကား',
    voiceEngineSectionTitle: '၃။ TTS အင်ဂျင်၊ စကားပြောဟန်နှင့် အသံအတိုးအကျယ်',
    speakersVoiceTitle: '၄။ စကားပြောသူအလိုက် ကျား/မ နှင့် အသံသတ်မှတ်ခြင်း',
    recapVoiceHint: 'Recap ပုံစံတွင် နောက်ခံပြောသံ (Narrator) နှင့် စကားပြောသူ အသံများကို စမ်းသပ်ရွေးချယ်ထားနိုင်ပါသည်။',
    modelsManagedInSettingsHint: 'AI မော်ဒယ်များ (TEXT / TRANSCRIBE / TTS) ကို ညာဘက်အပေါ်ရှိ "ဆက်တင်" ထဲတွင် ပြင်ဆင်နိုင်ပါသည်။',
    studioTabDubbing: 'Dubbing စတူဒီယို',
    studioTabRecap: 'Recap Script စတူဒီယို',
    recapStudioReservedTitle: 'Recap Script Studio (Stage 4)',
    recapStudioReservedDesc: 'အဆင့် ၂ ခွဲခြမ်းစိတ်ဖြာမှုနှင့် 480p CFR proxy များ အသင့်ဖြစ်နေပါပြီ။',
    recapReadyInputsTitle: 'အသင့်ရှိနေသော အချက်အလက်များ',
    recapSwitchToDubBtn: 'Dubbing စတူဒီယိုသို့ ပြောင်းသုံးမယ်',
    noRenderYetTitle: 'အသံထပ်ပြီး ဗီဒီယို မထုတ်ရသေးပါ',
    noRenderYetDesc: 'Step 4 (စတူဒီယို) တွင် ဘာသာပြန်ပြီး ဗီဒီယိုထုတ်မယ် ခလုတ်ကို နှိပ်ပါ။',
    workbenchReviewTitle: 'Timeline Workbench ပြန်လည်စစ်ဆေးခြင်း',
    tabDubTimeline: 'အသံထပ် Timeline ({count})',
    drawerTitle: 'ဆက်တင်နှင့် API Quota',
    drawerSubtitle: 'API KeyPool၊ မော်ဒယ်ရွေးချယ်မှု၊ TTS အသံအုပ်စုများနှင့် ဆာဗာလမ်းကြောင်းများ',
    drawerTabModels: 'မော်ဒယ်နှင့် API Quota',
    drawerTabVoices: 'အသံအုပ်စုနှင့် စမ်းသပ်မှု',
    drawerTabPaths: 'လမ်းကြောင်းနှင့် စနစ်',
    keyPoolTitle: 'API KeyPool နှင့် Quota အခြေအနေ',
    keyPoolLoadedKeys: 'ထည့်သွင်းထားသော Keys',
    keyPoolResetLabel: 'PT Reset အချိန်',
    keyPoolWaitingLabel: 'စောင့်ဆိုင်းနေသည့် အကြောင်းရင်း',
    keyPoolLiveHint: 'အလုပ်လုပ်နေစဉ် key တစ်ခုချင်းစီ၏ 429 cooldown/quota အခြေအနေကို ဤနေရာတွင် အချိန်နှင့်တပြေးညီ ပြပေးပါမည်။',
    closeBtn: 'ပိတ်မယ်',
    lockedStepHint: 'ရှေ့အဆင့်ကို အရင်ပြီးအောင် လုပ်ဆောင်ပါ',
  },
  recapStudio: {
    title: 'Recap Script စတူဒီယို (Movie Recap Studio)',
    subtitle: 'ဗီဒီယိုတစ်ပုဒ်လုံး (00:00 မှ အဆုံးထိ) အတွက် မြန်မာ Movie Recap ဇာတ်ညွှန်းကို ရေးသား/တည်းဖြတ်ပြီး နောက်ခံပြောသံ + ဗီဒီယို Beat Sync ဖြင့် ထုတ်ပေးပါမည်။',
    sourceModeTitle: 'Recap ဇာတ်ညွှန်း ဖန်တီးမည့် နည်းလမ်း',
    autoDetectedBadge: 'အလိုအလျောက် ရွေးချယ်ထားသည်',
    optionATitle: 'ဗီဒီယိုကြည့်ပြီး Recap ဇာတ်ညွှန်းအသစ် ရေးမည်',
    optionADesc: 'နောက်ခံပြောသံမပါသည့် ရုပ်ရှင်/ဇာတ်ကားအတွက် Gemini မှ 480p proxy ဗီဒီယိုနှင့် စကားပြောအချက်အလက်ကို ကြည့်၍ မြန်မာ Recap ဇာတ်ညွှန်းအသစ် ရေးပေးပါမည်။',
    optionBTitle: 'ပါပြီးသား Recap Voiceover ကို ဘာသာပြန်မည်',
    optionBDesc: 'တရုတ်/အင်္ဂလိပ် Recap နောက်ခံပြောသံ ပါပြီးသား ဗီဒီယိုအတွက် S1 မှတ်တမ်းကို ကျစ်လစ်ထိမိသော မြန်မာ Recap စာကြောင်းများအဖြစ် ဘာသာပြန်ပေးပါမည်။',
    narratorVoiceLabel: 'နောက်ခံပြောသူ အသံ (Narrator)',
    previewVoiceBtn: 'အသံစမ်းမယ်',
    generateBtn: 'Recap ဇာတ်ညွှန်း ရေးမယ်',
    regenerateBtn: 'အသစ်ပြန်ရေးမယ်',
    generatingBtn: 'ဇာတ်ညွှန်း ရေးနေသည်...',
    visualAiBtn: 'Visual AI ဇာတ်ညွှန်း (အသံမပါ)',
    visualAiHint: 'FFmpeg keyframes + Groq Vision ဖြင့် ဇာတ်ညွှန်း အတင်းရေးမယ် — အသံမပါ/တီးလုံး/သီချင်းဆူညံသော ဗီဒီယိုများအတွက်။',
    saveEditsBtn: 'တည်းဖြတ်ချက် သိမ်းမယ်',
    savingBtn: 'သိမ်းနေသည်...',
    savedBadge: 'သိမ်းပြီး',
    approveRenderBtn: 'Approve & Render Recap Video',
    renderingBtn: 'Recap ဗီဒီယို ထုတ်နေသည်...',
    addBeatBtn: '+ Beat အသစ်ထည့်မယ်',
    emptyScriptHint: 'အပေါ်ရှိ နည်းလမ်း (Option A သို့မဟုတ် B) ကို ရွေးချယ်ပြီး "Recap ဇာတ်ညွှန်း ရေးမယ်" ကို နှိပ်ပါ။',
    beatsSummaryLabel: 'ဇာတ်ညွှန်း Beats: {count} ခု · ၁.၂၀x နှုန်း / ၁၅၀% အသံ · ဗီဒီယို ၀.၆၀x ထိ Beat Sync',
    colBeatId: '#',
    colTimeSlot: 'အချိန် / ကြာချိန်',
    colContext: 'မြင်ကွင်း / မူရင်းအချက်အလက်',
    colNarration: 'မြန်မာ Recap ဇာတ်ညွှန်း (တည်းဖြတ်နိုင်)',
    colSyncInfo: 'TTS vs Slot / နှုန်း',
    colActions: 'လုပ်ဆောင်ချက်',
    syllableOkLabel: '{syl}/{max} syl (အဆင်ပြေ)',
    syllableOverLabel: '{syl}/{max} syl (ရှည်နေသည် — ဗီဒီယို 0.60x ထိ နှေးပေးမည်)',
    audioBedInfo: 'demucs ဖြင့် မူရင်းစကားသံ ၁၀၀% ဖယ်ပြီး BGM/SFX ၂၀% ချန်ထားမည်',
    unsavedHint: 'မသိမ်းရသေးသော တည်းဖြတ်ချက်များ ရှိသည်',
  },
} as const;

export type LocaleMessages = {
  brand: string;
  nav: {
    projects: string;
    workbench: string;
    settings: string;
    environment: string;
    newProject: string;
  };
  errors: {
    ffmpegNotFound: string;
    notEnoughDisk: string;
    missingGeminiKey: string;
    missingGeminiKeyAiStudio: string;
    uploadInterrupted: string;
    invalidGeminiKey: string;
    genericFailed: string;
    serverStartingRetry: string;
    serverStartupFailed: string;
    retryHealthBtn: string;
    serverLogsTitle: string;
    geminiQuotaExceeded: string;
  };
  projects: {
    title: string;
    subtitle: string;
    newProjectBtn: string;
    createTitle: string;
    cancel: string;
    projectTitleLabel: string;
    projectTitlePlaceholder: string;
    defaultTitlePrefix: string;
    modeLabel: string;
    modeDubbingShort: string;
    modeRecapShort: string;
    outputLangLabel: string;
    langMy: string;
    langEn: string;
    langBoth: string;
    creating: string;
    createSubmit: string;
    loadingList: string;
    emptyTitle: string;
    emptyDesc: string;
    createFirstBtn: string;
    colProject: string;
    colMode: string;
    colMedia: string;
    colProgress: string;
    colActions: string;
    uploadingLabel: string;
    noVideoUploaded: string;
    openBtn: string;
    deleteAria: string;
    stage1DoneLabel: string;
    stage1PendingLabel: string;
    noDialogue: string;
  };
  workbench: {
    noVideo: string;
    modeDubbing: string;
    modeRecap: string;
    langMy: string;
    langEn: string;
    langBoth: string;
    vStartLabel: string;
    aStartLabel: string;
    offsetLabel: string;
    guideTitle: string;
    guideSteps: readonly string[];
    uploadCardTitle: string;
    uploadCardDesc: string;
    pauseUploadBtn: string;
    selectVideoBtn: string;
    resumeVideoBtn: string;
    partialSavedPrefix: string;
    chunksUnit: string;
    reselectHint: string;
    chunkLabel: string;
    stage1Header: string;
    stage1DefaultLog: string;
    processingIngest: string;
    doneBtn: string;
    verifyIngestBtn: string;
    rerunBtn: string;
    s0Title: string;
    s1Title: string;
    s2Title: string;
    s3Title: string;
    stage2Tag: string;
    stage2Queued: string;
    statusDone: string;
    statusRunning: string;
    statusError: string;
    statusPending: string;
    previewProxyTitle: string;
    previewSourceTitle: string;
    back5s: string;
    forward5s: string;
    play: string;
    pause: string;
    extractedAudioTitle: string;
    audio16kTitle: string;
    audio48kTitle: string;
    noAudioNotice: string;
    noDialogueBanner: string;
    metaFpsMode: string;
    metaDuration: string;
    metaStartTimes: string;
    metaProxy: string;
    proxyNotGenerated: string;
    tabTranscript: string;
    tabSpeakers: string;
    tabMaps: string;
    tabJson: string;
    copyJson: string;
    copiedJson: string;
    shellTranscriptTitle: string;
    shellSpeakersTitle: string;
    shellMapsTitle: string;
    shellDesc: string;
    colId: string;
    colTimeRange: string;
    colDuration: string;
    colSpeaker: string;
    colLang: string;
    colText: string;
    colActions: string;
    saveRowBtn: string;
    savingRowBtn: string;
    savedRowBadge: string;
    emptyTranscript: string;
    colSpeakerId: string;
    colMergedFrom: string;
    colUtterances: string;
    colSampleAudio: string;
    colGenderSelect: string;
    colConfidence: string;
    genderMale: string;
    genderFemale: string;
    genderUnknown: string;
    noSampleFile: string;
    emptySpeakers: string;
    silenceSummaryTitle: string;
    sceneCutsSummaryTitle: string;
    silenceCountLabel: string;
    sceneCountLabel: string;
    speechCoverageLabel: string;
    seekBtnTitle: string;
    emptyMaps: string;
    dubStageCardTitle: string;
    tabDubbing: string;
    modelUsedPrefix: string;
    recapAudioToggleBtn: string;
    recapAudioMuted: string;
    recapAudioOn: string;
    chunksTitle: string;
    chunksSubtitle: string;
    chunksRunBtn: string;
    chunksResumeBtn: string;
    chunksRunningBtn: string;
    chunksDoneLabel: string;
    chunksPendingLabel: string;
    chunksErrorLabel: string;
    resumeFailedBtn: string;
    dualSubModeHint: string;
  };
  dubbing: {
    title: string;
    subtitle: string;
    duckingNotice: string;
    stepCSettingsTitle: string;
    ttsVolumeLabel: string;
    savingSettingsBtn: string;
    selectionLabel: string;
    modeFirstN: string;
    modeRange: string;
    modeAll: string;
    firstNCountLabel: string;
    rangeStartLabel: string;
    rangeEndLabel: string;
    selectionTestClipHint: string;
    selectionFullVideoHint: string;
    calibratedSpsLabel: string;
    etaLabel: string;
    secondsUnit: string;
    translateBtn: string;
    translatingBtn: string;
    renderBtn: string;
    renderingBtn: string;
    retranslateAllBtn: string;
    voiceMapTitle: string;
    voiceMapEmpty: string;
    colSpeaker: string;
    colGender: string;
    colGeminiVoice: string;
    colVoiceForEngine: string;
    colPreview: string;
    previewVoiceBtn: string;
    previewingVoiceBtn: string;
    glossaryTitle: string;
    cuesTableTitle: string;
    emptyCuesHint: string;
    langFilterLabel: string;
    colLineId: string;
    colSourceText: string;
    colTranslationEdit: string;
    colSlotTts: string;
    colRate: string;
    colStatus: string;
    colAction: string;
    regenerateBtn: string;
    regeneratingBtn: string;
    retranslateCompleteBtn: string;
    retranslatingCompleteBtn: string;
    incompleteWarningPrefix: string;
    modelUsedLabel: string;
    lengthVsSlotLabel: string;
    videoRateLabel: string;
    statusOk: string;
    statusCompressed: string;
    statusRetranslated: string;
    statusNeedsReview: string;
    statusOverflow: string;
    outputTitle: string;
    previewLangLabel: string;
    downloadMp4: string;
    downloadWav: string;
    downloadSrt: string;
    downloadEnglishSrt: string;
    downloadDualMp4: string;
    qaTitle: string;
    qaAvSyncLabel: string;
    qaPass40: string;
    qaFail40: string;
    qaStatusSummaryLabel: string;
    qaFlaggedTitle: string;
    qaAllClean: string;
  };
  environment: {
    title: string;
    subtitle: string;
    loading: string;
    recheckBtn: string;
    ffmpegCard: string;
    operational: string;
    unavailable: string;
    geminiCard: string;
    keyVerified: string;
    keyInvalid: string;
    keyMissing: string;
    catalogCount: string;
    optionalDemucs: string;
    demucsFound: string;
    demucsMissing: string;
    diskCard: string;
    freeSuffix: string;
    totalVolumePrefix: string;
    diskRuleHint: string;
    dataDirLabel: string;
    configHeader: string;
    configNote: string;
    apiText: string;
    apiTranscribe: string;
    apiGeminiTts: string;
    apiEdgeTts: string;
    requestsLabel: string;
    chunkSizeLabel: string;
    maxWindowLabel: string;
    silenceFilterLabel: string;
    sceneCutLabel: string;
    gapRatioLabel: string;
    startupNotesTitle: string;
    localTitle: string;
    localDesc: string;
  };
  settings: {
    title: string;
    subtitle: string;
    saveConfigBtn: string;
    savingConfigBtn: string;
    savedNotice: string;
    apiKeyCardTitle: string;
    apiKeyExistsLabel: string;
    apiKeyYes: string;
    apiKeyNo: string;
    apiKeyHiddenHint: string;
    modelsSectionTitle: string;
    modelsSectionDesc: string;
    modelsUnavailableNotice: string;
    textModelLabel: string;
    transcribeModelLabel: string;
    ttsModelLabel: string;
    speechStyleLabel: string;
    speechStylePolite: string;
    speechStyleCasual: string;
    ttsFallbacksLabel: string;
    textFallbacksLabel: string;
    ttsEngineTitle: string;
    ttsEngineDesc: string;
    engineEdge: string;
    engineGemini: string;
    edgeUnavailableBadge: string;
    poolsTitle: string;
    poolsDesc: string;
    langBurmeseTitle: string;
    langEnglishTitle: string;
    femalePoolLabel: string;
    malePoolLabel: string;
    emptyPoolHint: string;
    removeFromPoolAria: string;
    voiceListEdgeTitle: string;
    voiceListGeminiTitle: string;
    reloadVoicesBtn: string;
    loadingVoices: string;
    filterAllLocales: string;
    filterMyLocale: string;
    filterEnLocale: string;
    filterAllGender: string;
    filterFemale: string;
    filterMale: string;
    searchPlaceholder: string;
    sampleLangLabel: string;
    sampleMyLabel: string;
    sampleEnLabel: string;
    colVoiceName: string;
    colGender: string;
    colLocaleStyle: string;
    colDefaultPools: string;
    colPreview: string;
    genderFemale: string;
    genderMale: string;
    geminiAllLocalesLabel: string;
    addToMyPool: string;
    addToEnPool: string;
    previewBtn: string;
    previewingBtn: string;
    playingBanner: string;
    stopPlaybackBtn: string;
    ttsErrorTitle: string;
    emptyVoicesFilter: string;
    diagnosticOkTemplate: string;
    downloadBtn: string;
    selfTestBtn: string;
    selfTestingBtn: string;
    selfTestTitle: string;
  };
  persistence: {
    saveProjectBtn: string;
    savingZipLabel: string;
    restoreProjectBtn: string;
    restoringZipLabel: string;
    restoreFromBrowserBtn: string;
    restoringBrowserLabel: string;
    lastSavedLabel: string;
    serverSavedLabel: string;
    browserSavedLabel: string;
    notSavedYet: string;
    dataDirPrefix: string;
    includeSourceLabel: string;
    includeSourceOverLimitHint: string;
    savedCardTitle: string;
    savedSummaryLine: string;
    mediaOriginalAndProxy: string;
    mediaProxyOnly: string;
    mediaPending: string;
    browserBannerTitle: string;
    browserBannerDesc: string;
    restoreSuccessMsg: string;
    dismissBrowserBackup: string;
  };
  wizard: {
    pipelineTitle: string;
    pipelineEmptyHint: string;
    pipelineCardTitle: string;
    pipeAudioExtraction: string;
    pipeVocalSeparation: string;
    pipeQueued: string;
    pipeWaveVoice: string;
    pipeWaveMusic: string;
    resolutionUnknownLabel: string;
    step1Title: string;
    step1Sub: string;
    step2Title: string;
    step2Sub: string;
    step3Title: string;
    step3Sub: string;
    step4Title: string;
    step4Sub: string;
    step5Title: string;
    step5Sub: string;
    settingsBtn: string;
    switchProjectBtn: string;
    allProjectsSectionTitle: string;
    manageProjectsShowBtn: string;
    manageProjectsHideBtn: string;
    activeProjectBanner: string;
    uploadedReadyTitle: string;
    reuploadVideoBtn: string;
    selectVideoPrimaryBtn: string;
    chunkPreviewTitle: string;
    chunkPreviewDesc: string;
    chunkPreviewEstLabel: string;
    nextStep2Btn: string;
    nextStep3Btn: string;
    nextStep4Btn: string;
    nextStep5Btn: string;
    backToStudioBtn: string;
    startNewProjectBtn: string;
    inspectDataTitle: string;
    tabMediaPreview: string;
    modeSectionTitle: string;
    modeDubbingDesc: string;
    modeRecapDesc: string;
    targetLangSectionTitle: string;
    voiceEngineSectionTitle: string;
    speakersVoiceTitle: string;
    recapVoiceHint: string;
    modelsManagedInSettingsHint: string;
    studioTabDubbing: string;
    studioTabRecap: string;
    recapStudioReservedTitle: string;
    recapStudioReservedDesc: string;
    recapReadyInputsTitle: string;
    recapSwitchToDubBtn: string;
    noRenderYetTitle: string;
    noRenderYetDesc: string;
    workbenchReviewTitle: string;
    tabDubTimeline: string;
    drawerTitle: string;
    drawerSubtitle: string;
    drawerTabModels: string;
    drawerTabVoices: string;
    drawerTabPaths: string;
    keyPoolTitle: string;
    keyPoolLoadedKeys: string;
    keyPoolResetLabel: string;
    keyPoolWaitingLabel: string;
    keyPoolLiveHint: string;
    closeBtn: string;
    lockedStepHint: string;
  };
  recapStudio: {
    title: string;
    subtitle: string;
    sourceModeTitle: string;
    autoDetectedBadge: string;
    optionATitle: string;
    optionADesc: string;
    optionBTitle: string;
    optionBDesc: string;
    narratorVoiceLabel: string;
    previewVoiceBtn: string;
    generateBtn: string;
    regenerateBtn: string;
    generatingBtn: string;
    visualAiBtn: string;
    visualAiHint: string;
    saveEditsBtn: string;
    savingBtn: string;
    savedBadge: string;
    approveRenderBtn: string;
    renderingBtn: string;
    addBeatBtn: string;
    emptyScriptHint: string;
    beatsSummaryLabel: string;
    colBeatId: string;
    colTimeSlot: string;
    colContext: string;
    colNarration: string;
    colSyncInfo: string;
    colActions: string;
    syllableOkLabel: string;
    syllableOverLabel: string;
    audioBedInfo: string;
    unsavedHint: string;
  };
};
