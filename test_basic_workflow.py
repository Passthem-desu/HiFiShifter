"""
测试基础链路：导入音频 → 编辑音高 → 导出音频

运行前确保：
1. 已激活 diffsinger conda 环境
2. 已加载模型
3. 有测试音频文件
"""

import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from hifi_shifter.audio_processor import AudioProcessor
from hifi_shifter.project import ProjectManager
import numpy as np


def test_basic_workflow():
    """测试基础工作流程"""
    
    print("=" * 60)
    print("HiFiShifter 多轨道系统 - 基础链路测试")
    print("=" * 60)
    
    # 1. 初始化 AudioProcessor
    print("\n[1/6] 初始化 AudioProcessor...")
    processor = AudioProcessor()
    
    # 2. 加载模型
    print("[2/6] 加载默认模型...")
    model_dir = project_root / 'pc_nsf_hifigan_44.1k_hop512_128bin_2025.02'
    if not model_dir.exists():
        print(f"错误：模型目录不存在 {model_dir}")
        return False
    
    processor.load_model(str(model_dir))
    print(f"  ✓ 模型已加载，设备: {processor.device}")
    
    # 3. 创建工程
    print("[3/6] 创建新工程...")
    pm = ProjectManager(processor)
    project = pm.create_project("测试工程")
    print(f"  ✓ 工程已创建: {project.name}")
    print(f"  ✓ 默认轨道: {project.tracks[0].name}")
    
    # 4. 测试导入音频（如果有测试文件）
    test_audio_path = project_root / "test_audio.wav"
    if test_audio_path.exists():
        print(f"[4/6] 导入测试音频: {test_audio_path.name}...")
        
        track_id = project.tracks[0].id
        clip = pm.clip_manager.import_audio(str(test_audio_path), track_id, start_time=0.0)
        
        if clip:
            print(f"  ✓ Clip 已创建: {clip.id}")
            print(f"  ✓ 时长: {clip.duration:.2f} 秒")
            print(f"  ✓ 音高数据形状: {clip.f0_midi.shape if clip.f0_midi is not None else 'None'}")
            
            # 5. 测试音高编辑（向上移动 2 个半音）
            print("[5/6] 测试音高编辑（+2 半音）...")
            if clip.edited_f0_midi is not None:
                modified_f0 = clip.edited_f0_midi.copy()
                modified_f0[~np.isnan(modified_f0)] += 2.0  # 升高 2 个半音
                pm.clip_manager.update_clip_f0(clip.id, modified_f0)
                print("  ✓ 音高已修改")
            
            # 6. 测试导出
            print("[6/6] 测试导出音频...")
            output_path = project_root / "test_output.wav"
            success = pm.audio_renderer.export_to_file(str(output_path))
            
            if success:
                print(f"  ✓ 音频已导出到: {output_path}")
                print(f"\n{'='*60}")
                print("✅ 所有测试通过！")
                print(f"{'='*60}")
                return True
            else:
                print("  ✗ 导出失败")
                return False
        else:
            print("  ✗ 导入音频失败")
            return False
    else:
        print(f"[4/6] 跳过音频导入（未找到测试文件: {test_audio_path}）")
        print("\n提示：要测试完整链路，请将测试音频文件放在项目根目录并命名为 test_audio.wav")
        print("\n✅ 工程创建和模型加载测试通过！")
        return True


if __name__ == "__main__":
    try:
        success = test_basic_workflow()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n❌ 测试失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
