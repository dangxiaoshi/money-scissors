export declare function isNull<T>(data: T | null | undefined): data is null | undefined;
export declare function merge(source: {
    [key: string]: any;
}, data: {
    [key: string]: any;
}): {
    [key: string]: any;
};
export declare function sleep(ms: number): Promise<void>;
