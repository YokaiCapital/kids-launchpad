export const DEFAULT_SHART_VIDEO='/assets/shart-introduction-v2.mp4';
export const BUILT_IN_SHART_VIDEOS=['/assets/shart-placeholder-v1.mp4','/assets/shart-introduction-v1.mp4',DEFAULT_SHART_VIDEO];
export const resolveShartVideo=video=>video===undefined||BUILT_IN_SHART_VIDEOS.includes(video)?DEFAULT_SHART_VIDEO:video;
