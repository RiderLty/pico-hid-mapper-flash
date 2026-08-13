// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

function decodeUF2Block(buffer) {
    if (buffer.length !== 512) {
        throw new Error('UF2 block must be 512 bytes');
    }
    
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    
    // Check magic numbers
    const magic0 = view.getUint32(0, true);
    const magic1 = view.getUint32(4, true);
    const magicEnd = view.getUint32(508, true);
    
    if (magic0 !== 0x0A324655 || magic1 !== 0x9E5D5157 || magicEnd !== 0x0AB16F30) {
        throw new Error('Invalid UF2 magic numbers');
    }
    
    const payloadSize = view.getUint32(16, true);
    
    return {
        flags: view.getUint32(8, true),
        flashAddress: view.getUint32(12, true),
        payloadSize: payloadSize,
        blockNumber: view.getUint32(20, true),
        totalBlocks: view.getUint32(24, true),
        boardFamily: view.getUint32(28, true),
        payload: new Uint8Array(buffer.buffer, buffer.byteOffset + 32, payloadSize)
    };
}

/**
 * UF2 标志位（Microsoft UF2 规范）。
 * 携带以下标志的块不包含闪存数据，应被跳过：
 * - 0x1000：文件容器
 * - 0x8000：文件容器开始（多文件 UF2 的容器头）
 * - 0x10000：文件容器结束
 * - 0x20000：忽略此块
 */
const UF2_FLAG_FILE_CONTAINER = 0x1000;
const UF2_FLAG_FILE_CONTAINER_START = 0x8000;
const UF2_FLAG_FILE_CONTAINER_END = 0x10000;
const UF2_FLAG_IGNORE = 0x20000;
const UF2_SKIP_FLAGS =
    UF2_FLAG_FILE_CONTAINER |
    UF2_FLAG_FILE_CONTAINER_START |
    UF2_FLAG_FILE_CONTAINER_END |
    UF2_FLAG_IGNORE;

export function uf2ToFlashBuffer(uf2Data) {
    // First pass - find address range and collect blocks
    let minAddr = Infinity;
    let maxAddr = 0;
    const blocks = [];

    for (let offset = 0; offset < uf2Data.length; offset += 512) {
        const blockData = uf2Data.slice(offset, offset + 512);
        try {
            const block = decodeUF2Block(blockData);

            // 跳过不携带闪存数据的容器/忽略块（如多文件 UF2 的容器头）
            if (block.flags & UF2_SKIP_FLAGS) {
                console.warn(`跳过容器/忽略块 #${block.blockNumber}（flags=0x${block.flags.toString(16)}）`);
                continue;
            }

            blocks.push(block);
            minAddr = Math.min(minAddr, block.flashAddress);
            maxAddr = Math.max(maxAddr, block.flashAddress + block.payloadSize);
        } catch (e) {
            console.warn(`Invalid UF2 block at offset ${offset}: ${e.message}`);
            throw new Error('UF2 file is corrupted or invalid');
        }
    }

    // 没有任何可烧录的数据块
    if (blocks.length === 0) {
        throw new Error('UF2 file contains no flashable data blocks');
    }

    // Create buffer filled with 0xFF (erased flash state)
    const size = maxAddr - minAddr;
    const buffer = new Uint8Array(size);
    buffer.fill(0xFF);
    
    // Second pass - copy data into buffer
    for (const block of blocks) {
        const offset = block.flashAddress - minAddr;
        buffer.set(block.payload, offset);
    }

    console.log(`UF2 converted: Address range 0x${minAddr.toString(16)} - 0x${maxAddr.toString(16)}, Size: ${size} bytes, Blocks: ${blocks.length}`);

    return { 
        address: minAddr, 
        data: buffer 
    };
}