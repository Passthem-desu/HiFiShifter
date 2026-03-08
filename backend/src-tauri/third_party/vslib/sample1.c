//--------------------------------------------------------------
// WAVEファイルを半音ピッチシフトするサンプル
//--------------------------------------------------------------

#include "vslib.h"

int main( int argc, char *argv[] )
{
	if( argc == 3 ){
		HVSPRJ hVsprj;			// プロジェクトハンドル
		VSITEMINFO itemInfo;	// アイテム情報
		int itemNum;			// アイテム番号
		int ctrlPnt;			// 制御点番号

		// 新規プロジェクト作成
		VslibCreateProject( &hVsprj );

		// プロジェクトにアイテム追加
		VslibAddItem( hVsprj, argv[1], &itemNum );

		// アイテム情報取得
		VslibGetItemInfo( hVsprj, itemNum, &itemInfo );
		
		// 全ての制御点のピッチを+100centする
		for( ctrlPnt=0; ctrlPnt<itemInfo.ctrlPntNum; ctrlPnt++ ){
			VSCPINFOEX cpInfo;		// アイテム制御点情報

			// 制御点情報取得
			VslibGetCtrlPntInfoEx( hVsprj, itemNum, ctrlPnt, &cpInfo );

			// ピッチシフト
			cpInfo.pitEdit += 100;

			// 制御点情報設定
			VslibSetCtrlPntInfoEx( hVsprj, itemNum, ctrlPnt, &cpInfo );
		}
		
		// waveファイル出力
		VslibExportWaveFile( hVsprj, argv[2], 16, 2 );

		// プロジェクト破棄
		VslibDeleteProject( hVsprj );
	}

	return 0;
}
